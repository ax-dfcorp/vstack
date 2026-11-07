// Compaction summaries written from the conversation's own prompt cache.
//
// Pi's compaction summary is a separate request (`cacheRetention: "none"`)
// that one-shot-summary.ts runs as an isolated query: Pi's summarization system
// prompt, no tools, and the conversation serialized into one user message. All
// of it is uncached input. On the subscription weekly limit uncached input
// weighs 40 times a cache read, so while the conversation's cache is still
// warm the same summary is far cheaper written by the conversation itself:
// Claude Code's own compaction does exactly that ("the request repeats your
// conversation's system prompt, tools, and the history being summarized ...
// while the cache is warm, that request reads your prefix from the cache",
// code.claude.com prompt-caching).
//
// So when Pi starts a compaction (`session_before_compact`), the bridge notes
// which messages it summarizes. If the summary request that follows is that
// compaction's ordinary summary, no query of the conversation is live, the
// shared Claude session is in sync with Pi, and its last request started
// within the cache lifetime, the summary is asked of a resumed copy of that
// session: the same model, effort, account, tool declarations, and recorded
// system prompt as the last turn (the options `recordSideQuestionBase` keeps),
// `persistSession: false` so the exchange never reaches the transcript, one
// model turn, and every tool call denied. Pi's instructions, previous summary,
// custom focus, and the boundary (the last message to summarize; everything
// after it stays verbatim) go into the request's prompt.
//
// Anything else keeps the one-shot path: a split-turn or branch summary, an
// overflow compaction (the resumed context is what overflowed), a live query
// (writing into it deadlocked before, CHANGELOG "isolated one-shot queries"),
// or a cold cache, where both paths read everything uncached and the one-shot
// path is the cheaper one. A resumed summary that calls a tool, stops at the
// length limit, or fails in any way is discarded and the one-shot path runs
// instead.

import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Options, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { createHash } from "crypto";
import { debug } from "./debug.js";

/** A summary takes the cached path only if the conversation's last request started this recently (the cache lives 60 minutes from it). */
export const CACHED_SUMMARY_MAX_IDLE_MS = 55 * 60 * 1000;
const SNIPPET_CHARS = 160;
/**
 * With a summary substitute configured for the session model (Fable -> Opus),
 * the cached path must beat the substitute's isolated request on the weekly
 * limit: Fable at weight 10 reading N tokens at 0.025 and writing S at 5, vs
 * Opus at 2.2 reading N uncached and writing S at 5, i.e. 0.25N + 50S <
 * 2.2N + 11S, N > 20S. With summaries of up to ~10k tokens that is ~200k.
 */
export const CACHED_SUMMARY_MIN_CONTEXT_WITH_SUBSTITUTE = 200_000;

export interface CompactionNote {
	/** sha256 of Pi's own serialization of the messages it summarizes: the
	 *  summary request carries only that text (and, since Pi 1.5, a fresh
	 *  routing id instead of the session id), so this is what ties the request
	 *  to the compaction. Undefined when the host does not export the serializer. */
	conversationDigest: string | undefined;
	reason: "manual" | "threshold" | "overflow";
	isSplitTurn: boolean;
	/** Where the summary ends, in words the model can find in its transcript. */
	boundary: string | undefined;
	/** The shared Claude session covered every Pi message when the compaction started. */
	inSync: boolean;
	at: number;
}

let pendingCompaction: CompactionNote | null = null;

export function noteCompaction(note: CompactionNote | null): void {
	pendingCompaction = note;
}

/** The noted compaction, if `promptText` is its summary request; consumed once. */
export function takeCompactionNote(promptText: string | undefined): CompactionNote | null {
	const note = pendingCompaction;
	pendingCompaction = null;
	if (!note?.conversationDigest || !promptText) return null;
	const conversation = serializedConversation(promptText);
	if (conversation === undefined || digest(conversation) !== note.conversationDigest) return null;
	return note;
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Digest of the text Pi will put in `<conversation>` for these messages, or undefined when the host lacks the serializer (older Pi). */
export function conversationDigestOf(messages: unknown[]): string | undefined {
	const api = piCodingAgent as unknown as { convertToLlm?: (messages: unknown[]) => unknown[]; serializeConversation?: (messages: unknown[]) => string };
	if (typeof api.convertToLlm !== "function" || typeof api.serializeConversation !== "function") return undefined;
	try {
		return digest(api.serializeConversation(api.convertToLlm(messages)));
	} catch (error) {
		debug("conversationDigestOf failed:", error);
		return undefined;
	}
}

const CONVERSATION_ENDS = ["\n</conversation>\n\n<previous-summary>\n", "\n</conversation>\n\nThe messages above are a conversation to summarize."];

function conversationEnd(promptText: string): number {
	if (!promptText.startsWith("<conversation>\n")) return -1;
	let end = -1;
	for (const marker of CONVERSATION_ENDS) end = Math.max(end, promptText.lastIndexOf(marker));
	return end;
}

function serializedConversation(promptText: string): string | undefined {
	const end = conversationEnd(promptText);
	return end < 0 ? undefined : promptText.slice("<conversation>\n".length, end);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join(" ");
}

function snippet(text: string): string | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/** "the user message that begins …" for the last message Pi summarizes; undefined when it cannot be named. */
export function describeBoundaryMessage(message: unknown): string | undefined {
	const msg = message as { role?: string; content?: unknown; toolName?: string; summary?: string } | undefined;
	if (!msg) return undefined;
	if (msg.role === "assistant") {
		const text = snippet(textOf(msg.content));
		if (text) return `your reply that begins "${text}"`;
		const calls = Array.isArray(msg.content) ? msg.content.filter((block: any) => block?.type === "toolCall").map((block: any) => `\`${block.name}\``) : [];
		return calls.length > 0 ? `your call to ${calls.join(", ")}` : undefined;
	}
	if (msg.role === "toolResult") {
		const text = snippet(textOf(msg.content));
		return msg.toolName ? `the result of your \`${msg.toolName}\` call${text ? ` that begins "${text}"` : ""}` : undefined;
	}
	const text = snippet(textOf(msg.content) || (typeof msg.summary === "string" ? msg.summary : ""));
	return text ? `the user message that begins "${text}"` : undefined;
}

/**
 * Pi's ordinary summary prompt without its serialized conversation: the
 * optional <previous-summary> and the instructions (initial or update prompt,
 * plus "Additional focus"). Undefined for any other shape (turn-prefix and
 * branch summaries).
 */
export function summaryInstructions(promptText: string): string | undefined {
	const end = conversationEnd(promptText);
	if (end < 0) return undefined;
	const rest = promptText.slice(end + "\n</conversation>\n\n".length);
	if (!rest.includes("## Critical Context") || !/The messages above are (a conversation to summarize|NEW conversation messages)/.test(rest)) return undefined;
	return rest;
}

export function buildCachedSummaryPrompt(systemPrompt: string | undefined, instructions: string, boundary: string): string {
	return [
		"<summary_request>",
		"This request is not a turn of the conversation. Answer only this request, and do not call any tools.",
		"",
		...(systemPrompt?.trim() ? ["Instructions for this request:", systemPrompt.trim(), ""] : []),
		`Scope: "the messages above" means this conversation before this request, from its start through ${boundary}. Everything after that message stays in the context verbatim after your summary, so leave it out of the summary.`,
		"",
		instructions,
		"</summary_request>",
	].join("\n");
}

export interface CachedSummaryConditions {
	note: CompactionNote | null;
	promptText: string | undefined;
	liveQuery: boolean;
	nested: boolean;
	session: { sessionId: string; cwd: string; claudeConfigDir?: string; accountProfileId?: string; needsRebuild?: boolean } | null;
	base: { model: string; cwd: string; claudeConfigDir?: string } | null;
	lastRequest: { at: number; model: string; accountProfileId?: string } | null;
	model: string;
	now: number;
}

/** Why the cached path does not apply, or undefined when it does. */
export function cachedSummaryRefusal(c: CachedSummaryConditions): string | undefined {
	if (!c.note) return "no compaction noted for this request";
	if (c.note.isSplitTurn) return "split-turn compaction";
	if (c.note.reason === "overflow") return "overflow compaction";
	if (!c.note.boundary) return "boundary message cannot be named";
	if (!c.note.inSync) return "shared session behind Pi history";
	if (!c.promptText || !summaryInstructions(c.promptText)) return "not an ordinary compaction summary prompt";
	if (c.nested) return "nested query context";
	if (c.liveQuery) return "a query of the conversation is live";
	if (!c.session || c.session.needsRebuild) return "no reusable shared session";
	if (!c.base) return "no recorded turn options";
	if (c.base.model !== c.model) return `last turn ran ${c.base.model}`;
	if (c.base.cwd !== c.session.cwd || (c.base.claudeConfigDir ?? undefined) !== (c.session.claudeConfigDir ?? undefined)) return "the shared session moved since the last turn";
	if (!c.lastRequest) return "no request recorded";
	if (c.lastRequest.model !== c.model || (c.lastRequest.accountProfileId ?? undefined) !== (c.session.accountProfileId ?? undefined)) return "last request on another model or account";
	const idle = c.now - c.lastRequest.at;
	if (idle > CACHED_SUMMARY_MAX_IDLE_MS) return `cache cold (${Math.round(idle / 60000)} min idle)`;
	return undefined;
}

/** Deny every tool call: the request still declares the conversation's tools (they lead the cached prefix), but a summary must never run one. */
export function denyAllToolsHook(): HookCallbackMatcher {
	return {
		hooks: [async () => ({
			hookSpecificOutput: {
				hookEventName: "PreToolUse" as const,
				permissionDecision: "deny" as const,
				permissionDecisionReason: "Writing a summary: tools are not available.",
			},
		})],
	};
}

/** The last turn's options, resumed without persisting, limited to one model turn, with tools denied. */
export function cachedSummaryOptions(baseOptions: Options, sessionId: string): Options {
	const hooks = baseOptions.hooks ?? {};
	return {
		...baseOptions,
		resume: sessionId,
		persistSession: false,
		maxTurns: 1,
		hooks: { ...hooks, PreToolUse: [...(hooks.PreToolUse ?? []), denyAllToolsHook()] },
	};
}

/**
 * Pipes `attempt` into `stream` only once it finished cleanly; any failure
 * (error, abort excepted, or a length stop) discards it and runs `fallback`
 * instead. Buffering is what makes the fallback safe: Pi sees one summary.
 */
export function withFallback(
	stream: AssistantMessageEventStream,
	attempt: AssistantMessageEventStream,
	fallback: () => AssistantMessageEventStream,
	signal: AbortSignal | undefined,
	label: string,
): void {
	void (async () => {
		const buffered: AssistantMessageEvent[] = [];
		let ok = false;
		let aborted = false;
		try {
			for await (const event of attempt) {
				buffered.push(event);
				if (event.type === "done") {
					const text = event.message.content.reduce((all, block) => all + (block.type === "text" ? block.text : ""), "");
					ok = event.reason !== "length" && text.trim().length > 0;
				}
				if (event.type === "error") aborted = event.reason === "aborted";
				if (event.type === "done" || event.type === "error") {
					if (!ok) debug(`${label}: ${event.type === "error" ? String(event.error.errorMessage ?? "error").slice(0, 200) : event.reason === "length" ? "stopped at the length limit" : "no summary text"}`);
				}
			}
		} catch (error) {
			debug(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (ok) {
			for (const event of buffered) stream.push(event);
			stream.end();
			return;
		}
		if (aborted || signal?.aborted) {
			const last = buffered[buffered.length - 1];
			if (last) stream.push(last);
			stream.end();
			return;
		}
		debug(`${label}: falling back to the one-shot summary`);
		for await (const event of fallback()) stream.push(event);
		stream.end();
	})();
}
