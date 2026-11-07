// One cache-keeping request while a large conversation sits idle.
//
// The conversation's prompt cache lives 60 minutes from its last request
// (1-hour TTL, refreshed by every request that reads it). A user who returns
// after that pays a full re-write of the conversation on the next turn: on the
// subscription weekly limit 1.25 per token instead of 0.025 for a read. So when
// the top-level conversation has been silent for `afterMinutes` (53) after its
// last real request, its context was at least `minContextTokens` (100k), no
// query of it is running, and its account is still routable for its model, the
// bridge sends one tiny request through a resumed, non-persisted copy of the
// shared Claude session with the last turn's exact options (the same shape as
// the cache-aware summary, cached-summary.ts). It reads the whole prefix from
// cache and refreshes its lifetime for another hour. At most `maxWarms` (1) per
// idle stretch: Daseo unloads an idle Pi after 60 minutes, and this does not
// keep it alive or delay that; the timer dies with the process.
//
// Pi core has its own cache warmer, but it never fires for bridge models: they
// carry no `promptCache` lifetime (models.ts), so it stops with "cache
// lifetime unavailable".

import type { KeepWarmConfig } from "./config.js";
import type { SessionState, TopLevelRequest } from "./bridge-state.js";
import type { SideQuestionBase } from "./side-question.js";
import { debug } from "./debug.js";

export interface KeepWarmSettings {
	enabled: boolean;
	afterMinutes: number;
	minContextTokens: number;
	maxWarms: number;
}

/** Retry interval after a refusal because a query was running. */
export const KEEP_WARM_RETRY_MS = 60_000;
/** No warm-up starts later than this after the last request: the cache (60 minutes) must still be there when it arrives. */
export const KEEP_WARM_LAST_CHANCE_MS = 58 * 60_000;
/** A warm-up counts only if it read at least this share of the last request's context from cache. */
export const KEEP_WARM_MIN_CACHE_READ_SHARE = 0.5;

export const DEFAULT_KEEP_WARM: KeepWarmSettings = { enabled: true, afterMinutes: 53, minContextTokens: 100_000, maxWarms: 1 };

export function keepWarmSettings(config: KeepWarmConfig | undefined): KeepWarmSettings {
	return { ...DEFAULT_KEEP_WARM, ...config };
}

export const KEEP_WARM_PROMPT = [
	"<cache_keepalive>",
	"This is an automated keep-alive request from the environment, not a message from the user, and it is not part of the conversation.",
	"Do not call any tools and do not continue any task. Reply with exactly: ok",
	"</cache_keepalive>",
].join("\n");

export interface KeepWarmState {
	settings: KeepWarmSettings;
	lastRequest: TopLevelRequest | null;
	liveQuery: boolean;
	session: SessionState | null;
	base: Pick<SideQuestionBase, "model" | "cwd" | "claudeConfigDir"> | null;
	/** The account router would still route this session's model to its account (not blocked, not moved). Undefined without a router. */
	accountRoutable: boolean | undefined;
	warms: number;
	now: number;
}

/** Why no warm-up is sent now, or undefined when one is due. */
export function keepWarmRefusal(state: KeepWarmState): string | undefined {
	const { settings, lastRequest, session, base } = state;
	if (!settings.enabled) return "disabled";
	if (state.warms >= settings.maxWarms) return `already warmed ${state.warms} time(s)`;
	if (!lastRequest) return "no request recorded";
	if (lastRequest.contextTokens < settings.minContextTokens) return `context ${lastRequest.contextTokens} < ${settings.minContextTokens}`;
	if (state.now - lastRequest.at < settings.afterMinutes * 60_000) return "not idle long enough";
	if (state.now - lastRequest.at >= 60 * 60_000) return "cache already expired";
	if (state.liveQuery) return "a query is running";
	if (!session || session.needsRebuild) return "no reusable shared session";
	if (!base) return "no recorded turn options";
	if (base.model !== lastRequest.model) return `last turn ran ${base.model}`;
	if (base.cwd !== session.cwd || (base.claudeConfigDir ?? undefined) !== (session.claudeConfigDir ?? undefined)) return "the shared session moved since the last turn";
	if ((lastRequest.accountProfileId ?? undefined) !== (session.accountProfileId ?? undefined)) return "last request on another account";
	if (state.accountRoutable === false) return "account blocked or session re-routed";
	return undefined;
}

export interface WarmUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface KeepWarmDeps {
	settings(): KeepWarmSettings;
	state(): Omit<KeepWarmState, "settings" | "warms" | "now">;
	/** Send the warm-up; resolves with its usage, rejects on failure. */
	warm(signal: AbortSignal): Promise<WarmUsage>;
	/** Called after a successful warm-up (router bookkeeping, diagnostics). */
	onWarmed(usage: WarmUsage, request: TopLevelRequest): void;
	onFailed?(error: unknown, request: TopLevelRequest): void;
	now?(): number;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(timer: unknown): void;
}

/** Arms one timer per idle stretch, measured from the last real request (or the last warm-up). */
export class KeepWarmScheduler {
	private timer: unknown;
	private warms = 0;
	private stretchAt: number | undefined;
	private lastWarmAt: number | undefined;
	private inFlight: AbortController | undefined;

	constructor(private readonly deps: KeepWarmDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
		else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
		this.timer = undefined;
	}

	/** A real top-level request started: a new idle stretch begins when it ends. */
	noteRequest(request: TopLevelRequest): void {
		if (this.stretchAt !== request.at) {
			this.stretchAt = request.at;
			this.warms = 0;
			this.lastWarmAt = undefined;
		}
		this.inFlight?.abort();
		this.inFlight = undefined;
		this.arm();
	}

	/**
	 * A query of this conversation is about to start. A warm-up still in flight
	 * is aborted before the new query resumes the same Claude session (two
	 * resumed children of one session must not overlap). The timer stays: if
	 * it fires while the query runs, the refusal retries a minute later, and
	 * the query's own requests re-arm it from their time.
	 */
	noteActivity(): void {
		this.inFlight?.abort();
		this.inFlight = undefined;
	}

	/** Stop everything: session switch, shutdown. */
	cancel(): void {
		this.clearTimer();
		this.inFlight?.abort();
		this.inFlight = undefined;
		this.stretchAt = undefined;
		this.warms = 0;
		this.lastWarmAt = undefined;
	}

	private arm(retryInMs?: number): void {
		this.clearTimer();
		const settings = this.deps.settings();
		if (!settings.enabled || this.stretchAt === undefined || this.warms >= settings.maxWarms) return;
		const from = this.lastWarmAt ?? this.stretchAt;
		const delay = retryInMs ?? Math.max(0, from + settings.afterMinutes * 60_000 - this.now());
		const callback = () => { this.timer = undefined; void this.fire(); };
		if (this.deps.setTimer) {
			this.timer = this.deps.setTimer(callback, delay);
		} else {
			const timer = setTimeout(callback, delay);
			// Never keeps the process alive: a print-mode run exits, and an idle
			// Pi that Daseo unloads takes the timer with it.
			timer.unref?.();
			this.timer = timer;
		}
	}

	private async fire(): Promise<void> {
		const settings = this.deps.settings();
		const state = this.deps.state();
		const lastRequest = state.lastRequest;
		// A second warm-up is measured from the first, so the request "age" check
		// uses the later of the two.
		const ageFrom = this.lastWarmAt !== undefined && lastRequest ? { ...lastRequest, at: this.lastWarmAt } : lastRequest;
		const refusal = keepWarmRefusal({ ...state, lastRequest: ageFrom, settings, warms: this.warms, now: this.now() });
		if (refusal || !lastRequest) {
			// A query that is still running when the timer fires (a long tool
			// call, a compaction) may finish before the cache expires: try again
			// a minute later while there is still time to refresh it.
			const from = ageFrom?.at;
			if (refusal === "a query is running" && from !== undefined && this.now() + KEEP_WARM_RETRY_MS < from + KEEP_WARM_LAST_CHANCE_MS) {
				debug(`keep-warm: not sent (${refusal}); retrying in ${KEEP_WARM_RETRY_MS / 1000}s`);
				this.arm(KEEP_WARM_RETRY_MS);
				return;
			}
			debug(`keep-warm: not sent (${refusal ?? "no request"})`);
			return;
		}
		const controller = new AbortController();
		this.inFlight = controller;
		const stretch = this.stretchAt;
		try {
			const usage = await this.deps.warm(controller.signal);
			if (controller.signal.aborted || this.stretchAt !== stretch) return;
			this.warms += 1;
			this.lastWarmAt = this.now();
			this.deps.onWarmed(usage, lastRequest);
			this.arm();
		} catch (error) {
			if (controller.signal.aborted) return;
			this.deps.onFailed?.(error, lastRequest);
		} finally {
			if (this.inFlight === controller) this.inFlight = undefined;
		}
	}

	/** For tests and diagnostics. */
	status(): { armed: boolean; warms: number; stretchAt?: number; lastWarmAt?: number } {
		return { armed: this.timer !== undefined, warms: this.warms, ...(this.stretchAt !== undefined ? { stretchAt: this.stretchAt } : {}), ...(this.lastWarmAt !== undefined ? { lastWarmAt: this.lastWarmAt } : {}) };
	}
}
