// Summarize a large conversation first when the user comes back after its
// prompt cache expired.
//
// A conversation's prompt cache lives 60 minutes from the last request that
// read or wrote it. Coming back later, the next turn re-writes the whole
// context: on the subscription weekly limit 1.25 per token, times the model's
// weight (Fable about 7.5, Opus 2.2), and every later request of the session
// reads that large context again. Compacting before that turn instead costs one
// summary request (Pi's summarizer; a Fable session's summary is written by the
// `summaryModelOverrides` substitute, Opus) plus a re-write of the much smaller
// compacted context. The price is detail: the summary keeps decisions and
// open items, not every tool result.
//
// The trigger is Pi's `input` event, which Pi awaits before it expands, queues
// or starts anything: when the session is idle on a configured model, its last
// cache refresh is at least `idleMinutes` old and its context at least
// `minContextTokens`, the handler runs Pi's own compaction (`ctx.compact`, the
// same path as /compact, so the user sees the normal compaction notice) and
// lets the message through once it ends. A failed compaction lets the message
// through unchanged (today's plain re-write); a cancelled one drops it, since
// the user stopped the turn.
//
// "Cache is gone" is judged from the last request of this model in the Pi
// session (assistant message time), the last top-level request this process
// saw, and the last successful keep-warm (keep-warm.ts), whichever is latest.
// Daseo unloads an idle Pi after 60 minutes, so a return usually lands in a new
// process with no memory of the warm-up: while this feature is on, each
// successful warm-up is recorded as a `claude-bridge-cache-warm` session entry
// (a CustomEntry, never part of the model's context).

import { isClaudeProvider } from "./convert.js";

export interface IdleCompactSettings {
	enabled: boolean;
	/** Minutes since the last cache refresh after which the cache counts as expired (default 60, the cache lifetime). */
	idleMinutes: number;
	/** Only conversations whose last request carried at least this many tokens. */
	minContextTokens: number;
	/** Session models it applies to. */
	models: string[];
}

export const DEFAULT_IDLE_COMPACT: IdleCompactSettings = {
	enabled: false,
	idleMinutes: 60,
	minContextTokens: 250_000,
	models: ["claude-fable-5-2", "claude-fable-5-1"],
};

export const CACHE_WARM_CUSTOM_TYPE = "claude-bridge-cache-warm";

/** `CLAUDE_BRIDGE_IDLE_COMPACT=0|1` overrides the configured switch (off/on, false/true, no/yes). */
export function idleCompactEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = (env.CLAUDE_BRIDGE_IDLE_COMPACT ?? "").trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return undefined;
}

export function idleCompactSettings(config: Partial<IdleCompactSettings> | undefined, env: NodeJS.ProcessEnv = process.env): IdleCompactSettings {
	const merged = { ...DEFAULT_IDLE_COMPACT, ...config };
	const override = idleCompactEnvOverride(env);
	return override === undefined ? merged : { ...merged, enabled: override };
}

/** The conversation's last cache-refreshing activity, as far as this process and the Pi session know. */
export interface CacheActivity {
	/** Epoch ms of the latest request or successful warm-up of `model`. */
	at: number;
	model: string;
	/** Context tokens of the last request (input + cache read + cache write + output). */
	contextTokens: number;
}

export interface IdleCompactState {
	settings: IdleCompactSettings;
	/** Current session model id, if it is a bridge model. */
	model: string | undefined;
	/** Pi is not running an agent turn, compaction, or queue. */
	idle: boolean;
	/** The input is a steer or follow-up into a running turn. */
	streaming: boolean;
	/** Where the input came from. */
	source: "interactive" | "rpc" | "extension";
	/** An idle compaction of this process is already running. */
	inFlight: boolean;
	activity: CacheActivity | undefined;
	/** The latest compaction entry is newer than the last request. */
	compactedSince: boolean;
	now: number;
}

/** Why no compaction runs before this input, or undefined when one is due. */
export function idleCompactRefusal(state: IdleCompactState): string | undefined {
	const { settings, activity } = state;
	if (!settings.enabled) return "disabled";
	if (state.inFlight) return "an idle compaction is already running";
	if (state.streaming || !state.idle) return "a turn is running";
	if (state.source === "extension") return "input sent by an extension";
	if (!state.model || !settings.models.includes(state.model)) return `model ${state.model ?? "none"} not configured`;
	if (!activity) return "no earlier request of this conversation";
	if (state.compactedSince) return "already compacted since the last request";
	if (activity.model !== state.model) return `last request ran ${activity.model}`;
	if (activity.contextTokens < settings.minContextTokens) return `context ${activity.contextTokens} < ${settings.minContextTokens}`;
	const idleMs = state.now - activity.at;
	if (idleMs < settings.idleMinutes * 60_000) return `cache still warm (${Math.round(idleMs / 60_000)} min since the last refresh)`;
	return undefined;
}

interface BranchEntryLike {
	type: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		timestamp?: number;
		stopReason?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
	};
}

function entryTime(entry: BranchEntryLike): number | undefined {
	const at = entry.message?.timestamp ?? (entry.timestamp ? Date.parse(entry.timestamp) : NaN);
	return Number.isFinite(at) ? at : undefined;
}

export interface SessionCacheView {
	activity: CacheActivity | undefined;
	compactedSince: boolean;
}

/**
 * The last bridge request and warm-up recorded on the current branch. An
 * assistant message without usage (aborted before the first token) is skipped:
 * it neither refreshed nor measured the cache.
 */
export function readSessionCacheActivity(branch: readonly unknown[]): SessionCacheView {
	let request: CacheActivity | undefined;
	let requestIndex = -1;
	let compactionIndex = -1;
	let warm: { at: number; model: string } | undefined;
	branch.forEach((raw, index) => {
		const entry = raw as BranchEntryLike;
		if (entry.type === "compaction") compactionIndex = index;
		if (entry.type === "custom" && entry.customType === CACHE_WARM_CUSTOM_TYPE) {
			const data = entry.data as { at?: unknown; model?: unknown } | undefined;
			if (typeof data?.at === "number" && typeof data.model === "string") warm = { at: data.at, model: data.model };
		}
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || !isClaudeProvider(message.provider) || !message.model) return;
		const usage = message.usage;
		const contextTokens = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0) : 0;
		const at = entryTime(entry);
		if (contextTokens <= 0 || at === undefined) return;
		request = { at, model: message.model, contextTokens };
		requestIndex = index;
	});
	if (request && warm && warm.model === request.model && warm.at > request.at) request = { ...request, at: warm.at };
	return { activity: request, compactedSince: compactionIndex > requestIndex };
}

/** Combine the session view with this process's own record (its last top-level request and warm-up). */
export function mergeCacheActivity(session: CacheActivity | undefined, live: CacheActivity | undefined): CacheActivity | undefined {
	if (!session) return live;
	if (!live || live.model !== session.model) return session;
	return live.at >= session.at ? { ...live, contextTokens: Math.max(live.contextTokens, session.contextTokens) } : session;
}

export type IdleCompactOutcome = { kind: "compacted"; tokensBefore?: number } | { kind: "failed"; error: string } | { kind: "cancelled" };

/** Pi's `session_compact_failed` for the compaction this module started. */
export interface CompactFailure {
	aborted: boolean;
	fromExtension: boolean;
}

/**
 * Runs Pi's compaction and settles once it ends (ctx.compact does not return a
 * promise). Pi reports a user abort and an extension's cancel with the same
 * error text; `failure()` (from `session_compact_failed`) tells them apart, and
 * only the user's abort counts as cancelled.
 */
export function runCompaction(
	compact: (options: { onComplete: (result: { tokensBefore?: number }) => void; onError: (error: Error) => void }) => void,
	failure: () => CompactFailure | undefined,
): Promise<IdleCompactOutcome> {
	return new Promise((resolve) => {
		try {
			compact({
				onComplete: (result) => resolve({ kind: "compacted", ...(typeof result?.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}) }),
				onError: (error) => {
					const reported = failure();
					resolve(reported?.aborted && !reported.fromExtension ? { kind: "cancelled" } : { kind: "failed", error: error.message });
				},
			});
		} catch (error) {
			resolve({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	});
}
