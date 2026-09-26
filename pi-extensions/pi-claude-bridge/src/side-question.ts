// Side questions (`/btw`): answer from the live conversation without adding to it.
//
// The Claude Code CLI answers these natively: the SDK's `Query.askSideQuestion`
// (control_request `side_question`, not in the SDK's public typings as of
// 0.3.280) forks the conversation with the session's own cache-safe request
// parameters, runs one tool-less model turn, and never writes the exchange to
// the session transcript. It is the same engine as Claude Code's `/btw`.
//
// Two paths, both measured 2026-09-26 on a 56k-token conversation:
//   * live — a Pi run is in flight, so the child process is up. The question
//     goes to that query; the main turn is not interrupted (asked during a
//     running Bash tool: answer in 1.4s, cacheRead 55,371 / cacheCreate 145).
//   * resumed — no child is running. A second child resumes the shared Claude
//     session with the options the last top-level turn used and
//     `persistSession: false`, asks, and closes without sending a prompt. The
//     options must match that turn exactly — tool declarations lead every
//     request, so a different tool list re-caches the whole conversation
//     (measured: cacheRead 56,233 / cacheCreate 65, session file untouched).

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionState } from "./bridge-state.js";
import { debug } from "./debug.js";

export const SIDE_QUESTION_HOST_SYMBOL = Symbol.for("vstack.pi.claude-bridge.side-question-host.v1");

/** How many earlier exchanges are replayed with each question (Claude Code's own limit). */
export const SIDE_QUESTION_HISTORY_LIMIT = 20;

export interface SideQuestionExchange {
	question: string;
	response: string;
}

export interface SideQuestionInput {
	question: string;
	history?: SideQuestionExchange[];
	signal?: AbortSignal;
}

export interface SideQuestionAnswer {
	text: string;
	/** The CLI produced a note instead of a model answer (for example: the model wrote tool calls). */
	synthetic: boolean;
	model: string;
	path: "live" | "resumed";
}

export interface ClaudeBridgeSideQuestionHostV1 {
	version: 1;
	ask(input: SideQuestionInput): Promise<SideQuestionAnswer>;
}

/** What the resumed path needs from the last top-level turn. */
export interface SideQuestionBase {
	model: string;
	cwd: string;
	claudeConfigDir?: string;
	/** The last turn's query options with fresh in-process MCP servers; `resume` is set by the caller. */
	buildOptions(): Options;
}

interface SideQuestionCapableQuery {
	askSideQuestion(
		question: string,
		options?: { history?: SideQuestionExchange[]; signal?: AbortSignal },
	): Promise<{ response: string; synthetic?: boolean } | null>;
	close?(): void;
}

export interface SideQuestionDeps {
	/** The top-level query while a Pi run is in flight and not aborting. */
	liveQuery(): unknown | null;
	session(): SessionState | null;
	base(): SideQuestionBase | null;
	queryFactory(params: { prompt: AsyncIterable<never>; options: Options }): unknown;
}

let recordedBase: SideQuestionBase | null = null;

export function recordSideQuestionBase(next: SideQuestionBase): void {
	recordedBase = next;
}

export function clearSideQuestionBase(): void {
	recordedBase = null;
}

export function sideQuestionBase(): SideQuestionBase | null {
	return recordedBase;
}

function isSideQuestionCapable(value: unknown): value is SideQuestionCapableQuery {
	return typeof (value as { askSideQuestion?: unknown } | null)?.askSideQuestion === "function";
}

function normalizeHistory(history: SideQuestionExchange[] | undefined): SideQuestionExchange[] {
	return (history ?? [])
		.filter((entry) => typeof entry?.question === "string" && typeof entry?.response === "string")
		.slice(-SIDE_QUESTION_HISTORY_LIMIT);
}

function toAnswer(
	result: { response: string; synthetic?: boolean } | null,
	model: string,
	path: SideQuestionAnswer["path"],
): SideQuestionAnswer {
	if (!result || !result.response) throw new Error("Claude returned no answer to the side question.");
	return { text: result.response, synthetic: result.synthetic === true, model, path };
}

function abortError(): Error {
	const error = new Error("Side question cancelled");
	error.name = "AbortError";
	return error;
}

/** The query ended between the liveness check and the request: fall back to resuming. */
function isClosedQueryError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /not ready for writing|Query closed|transport.*closed|process exited/i.test(message);
}

export async function askSideQuestion(input: SideQuestionInput, deps: SideQuestionDeps): Promise<SideQuestionAnswer> {
	const question = input.question.trim();
	if (!question) throw new Error("Ask a question after /btw.");
	const history = normalizeHistory(input.history);
	if (input.signal?.aborted) throw abortError();

	const live = deps.liveQuery();
	if (isSideQuestionCapable(live)) {
		try {
			const result = await live.askSideQuestion(question, { history, signal: input.signal });
			return toAnswer(result, deps.base()?.model ?? "claude", "live");
		} catch (error) {
			if (input.signal?.aborted) throw abortError();
			if (!isClosedQueryError(error)) throw error;
			debug(`side-question: live query closed before answering, resuming instead: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return askResumed(question, history, input.signal, deps);
}

async function askResumed(
	question: string,
	history: SideQuestionExchange[],
	signal: AbortSignal | undefined,
	deps: SideQuestionDeps,
): Promise<SideQuestionAnswer> {
	const session = deps.session();
	const base = deps.base();
	if (!session?.sessionId || !base) {
		throw new Error("There is no Claude conversation to ask about yet. Send a message first.");
	}
	if (session.cwd !== base.cwd || (session.claudeConfigDir ?? undefined) !== (base.claudeConfigDir ?? undefined)) {
		throw new Error("The Claude conversation moved since the last turn. Send a message first, then ask again.");
	}

	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	// Never yields: the child must answer the side question without starting a turn.
	async function* noPrompt(): AsyncGenerator<never> {
		await gate;
	}
	const options: Options = { ...base.buildOptions(), resume: session.sessionId, persistSession: false };
	const sideQuery = deps.queryFactory({ prompt: noPrompt(), options });
	if (!isSideQuestionCapable(sideQuery)) {
		release();
		throw new Error("This Claude Agent SDK does not support side questions.");
	}
	// Drain the message stream so the child's output never backs up; nothing in it is needed.
	const drained = (async () => {
		try {
			for await (const _message of sideQuery as unknown as AsyncIterable<unknown>) { /* discard */ }
		} catch (error) {
			debug(`side-question: resumed query stream ended: ${error instanceof Error ? error.message : String(error)}`);
		}
	})();
	debug(`side-question: resumed ${session.sessionId.slice(0, 8)} model=${base.model} history=${history.length}`);
	try {
		const result = await sideQuery.askSideQuestion(question, { history, signal });
		return toAnswer(result, base.model, "resumed");
	} catch (error) {
		if (signal?.aborted) throw abortError();
		throw error;
	} finally {
		release();
		try { sideQuery.close?.(); } catch { /* already closed */ }
		void drained;
	}
}
