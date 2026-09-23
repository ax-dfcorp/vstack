// One-shot isolated queries for Pi's summarization requests.
//
// Pi routes every compaction and branch summary through one choke point
// (`completeSummarization` in pi-coding-agent's compaction.js): the request
// carries `cacheRetention: "none"`, a summarization system prompt, and exactly
// one user message holding the instructions plus the serialized conversation.
// It is a self-contained completion, not a turn of the conversation.
//
// Treating it as a turn broke in two ways. While a tool-use query was live
// (auto-compaction firing mid tool loop) the request entered the tool-result
// delivery path, and `canInjectSteer` wrote the summary prompt into the live
// query's input channel as a steer: the child waited for tool results Pi would
// never send while Pi waited for a summary the child would never produce, until
// the stream-idle timeout (2 of 133 measured compactions). Between turns it
// resumed the shared Claude session, so the whole transcript was re-read to
// answer a prompt that already contains it, and the summary exchange landed in
// the main session's history.
//
// So this path runs its own query and its own consumer. It never reads or
// writes `ctx()` (the live query's stream, pending tool calls, watchdog, and
// input channel) or the shared session (no `syncSharedSession`, no resume, no
// cursor), and the child session is not persisted. Everything that must match
// ordinary turns — account routing, child environment, effort — is computed by
// the caller with the same helpers the normal path uses and handed in through
// `prepare`.

import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { EffortLevel, Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { isUsageLimitMessage, uniqueNonEmptyLines } from "./rate-limit.js";
import { classifyClaudeFailure, type ClaudeAccountFailureKind, type ClaudeAccountRoute, type ClaudeAccountRouterV1 } from "./account-router.js";
import { DISALLOWED_BUILTIN_TOOLS } from "./connectors.js";
import { createQueryInputChannel } from "./input-channel.js";
import { extractUserPrompt, extractUserPromptBlocks } from "./user-prompt.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { spawnClaudeCodeWithDiagnostics } from "./claude-executable.js";

/** Pi marks summarization requests (and only those) with cacheRetention "none".
 *  Older Pi versions never set the option, so `undefined` stays a normal turn. */
export function isOneShotSummaryRequest(options: SimpleStreamOptions | undefined): boolean {
	return options?.cacheRetention === "none";
}

export type OneShotPreparation =
	| {
		status: "ready";
		account?: ClaudeAccountRoute;
		router?: ClaudeAccountRouterV1;
		env: Record<string, string | undefined>;
		effort?: EffortLevel;
		extraArgs: Record<string, string | null>;
		fastMode: boolean;
		pathToClaudeCodeExecutable?: string;
	}
	| { status: "failed"; message: string; resetAtMs?: number; rateLimitType?: unknown };

export interface OneShotSummaryDeps {
	cwd: string;
	createStream: () => AssistantMessageEventStream;
	queryFactory: typeof query;
	/** Only for the debug line: whether a normal query is live beside this one. */
	activeQuery: boolean;
	/** Credential check, account selection, child env and effort — the same
	 *  values an ordinary turn on this model would use. */
	prepare: () => OneShotPreparation;
}

interface OneShotFailure {
	kind?: ClaudeAccountFailureKind;
	message: string;
	rateLimited?: boolean;
}

/** The prompt is the last user message. Pi's summarization context always holds
 *  exactly one; anything before it is not part of the request. */
function lastUserPromptBlocks(context: Context): ContentBlockParam[] {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const blocks = extractUserPromptBlocks([message]);
		if (blocks) return blocks;
		return [{ type: "text", text: extractUserPrompt([message]) ?? "" }];
	}
	return [{ type: "text", text: "" }];
}

function promptLength(blocks: ContentBlockParam[]): number {
	return blocks.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

function mapStopReason(reason: string | undefined): AssistantMessage["stopReason"] {
	return reason === "max_tokens" ? "length" : "stop";
}

export function streamOneShotSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: OneShotSummaryDeps,
): AssistantMessageEventStream {
	const stream = deps.createStream();
	const output: AssistantMessage = {
		role: "assistant", content: [],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
	let ended = false;
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};
	const fail = (message: string, reason: "error" | "aborted" = "error", extra?: Record<string, unknown>) => {
		if (ended) return;
		ended = true;
		output.stopReason = reason;
		output.errorMessage = message;
		if (extra) Object.assign(output as AssistantMessage & Record<string, unknown>, extra);
		stream.push({ type: "error", reason, error: output });
		stream.end();
	};
	const finish = () => {
		if (ended) return;
		ended = true;
		start();
		stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
		stream.end();
	};

	const prepared = deps.prepare();
	if (prepared.status === "failed") {
		debug(`provider: one-shot summary not started: ${prepared.message}`);
		queueMicrotask(() => fail(prepared.message, "error", Number.isFinite(prepared.resetAtMs)
			? { resetAtMs: prepared.resetAtMs, rateLimitType: prepared.rateLimitType }
			: undefined));
		return stream;
	}
	const { account, router } = prepared;

	const blocks = lastUserPromptBlocks(context);
	// Input held open until `result`, like ordinary queries; closing it there is
	// what ends the child. (A string prompt would work for text, but images need
	// structured content and one code path is simpler to reason about.)
	const inputChannel = createQueryInputChannel(blocks);
	const queryOptions: Options = {
		cwd: deps.cwd,
		model: model.id,
		env: prepared.env,
		// Pi's summarization system prompt, verbatim: no claude_code preset, no
		// AGENTS.md append, no recorded snapshot. Pi 0.87 fixed Fable's summary
		// refusals in this prompt, so it must reach the model unchanged.
		systemPrompt: context.systemPrompt ?? "",
		// No tools of any kind: built-ins off, nothing auto-allowed, no MCP servers
		// (Pi's tools or claude.ai connectors), and no filesystem MCP discovery.
		tools: [],
		allowedTools: [],
		disallowedTools: DISALLOWED_BUILTIN_TOOLS,
		strictMcpConfig: true,
		maxTurns: 1,
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// Ephemeral: the summary exchange must not become a resumable session or
		// land in the account's project history.
		persistSession: false,
		settings: { ...(prepared.fastMode ? { fastMode: true } : {}), autoMemoryEnabled: false },
		extraArgs: prepared.extraArgs,
		...(prepared.effort ? { effort: prepared.effort } : {}),
		...(prepared.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: prepared.pathToClaudeCodeExecutable } : {}),
		spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
		...makeCliDebugOptions("one-shot-summary"),
	};

	debug("provider: one-shot summary",
		`model=${model.id} promptChars=${promptLength(blocks)} images=${blocks.some((block) => block.type === "image")}`,
		`systemChars=${(context.systemPrompt ?? "").length} effort=${prepared.effort ?? "default"} account=${account?.label ?? "legacy"}`,
		`activeQuery=${deps.activeQuery} resume=none mcpTools=0`);

	const sdkQuery = deps.queryFactory({ prompt: inputChannel.stream, options: queryOptions });
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		inputChannel.close();
		// interrupt() asks the CLI to stop; close() kills it. Both, as elsewhere.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	if (options?.signal?.aborted) onAbort();
	else options?.signal?.addEventListener("abort", onAbort, { once: true });

	void consume().finally(() => {
		options?.signal?.removeEventListener("abort", onAbort);
		inputChannel.close();
		try { sdkQuery.close(); } catch {}
	});
	return stream;

	async function consume(): Promise<void> {
		// SDK content-block index -> index in output.content.
		const blockIndex = new Map<number, number>();
		let sawStreamContent = false;
		let resultUsage: Record<string, number | undefined> | undefined;
		const streamedUsage: Record<string, number | undefined> = {};
		let failure: OneShotFailure | undefined;

		const addBlock = (block: AssistantMessage["content"][number]): number => {
			start();
			output.content.push(block);
			return output.content.length - 1;
		};
		const addCompletedText = (text: string) => {
			if (!text) return;
			const index = addBlock({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: index, partial: output });
			stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
		};

		try {
			for await (const message of sdkQuery as AsyncIterable<SDKMessage>) {
				if (aborted) break;
				switch (message.type) {
					case "stream_event": {
						const event = (message as any).event;
						if (event?.type === "message_start") {
							Object.assign(streamedUsage, event.message?.usage ?? {});
						} else if (event?.type === "content_block_start") {
							const type = event.content_block?.type;
							if (type === "text") {
								sawStreamContent = true;
								const index = addBlock({ type: "text", text: "" });
								blockIndex.set(event.index, index);
								stream.push({ type: "text_start", contentIndex: index, partial: output });
							} else if (type === "thinking") {
								sawStreamContent = true;
								const index = addBlock({ type: "thinking", thinking: "", thinkingSignature: "" });
								blockIndex.set(event.index, index);
								stream.push({ type: "thinking_start", contentIndex: index, partial: output });
							} else {
								debug(`one-shot summary: ignoring ${type} content block`);
							}
						} else if (event?.type === "content_block_delta") {
							const index = blockIndex.get(event.index);
							const block = index === undefined ? undefined : output.content[index];
							if (!block || index === undefined) break;
							if (event.delta?.type === "text_delta" && block.type === "text") {
								block.text += event.delta.text;
								stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
							} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
								block.thinking += event.delta.thinking;
								stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
							} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
								block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
							}
						} else if (event?.type === "content_block_stop") {
							const index = blockIndex.get(event.index);
							const block = index === undefined ? undefined : output.content[index];
							if (!block || index === undefined) break;
							blockIndex.delete(event.index);
							if (block.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
							else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
						} else if (event?.type === "message_delta") {
							output.stopReason = mapStopReason(event.delta?.stop_reason);
							Object.assign(streamedUsage, event.usage ?? {});
						}
						break;
					}
					case "assistant": {
						const sdkError = (message as any).error;
						if (sdkError) {
							// Claude Code's synthetic rate/auth copy, not model output.
							failure ??= { kind: classifyClaudeFailure(sdkError), message: String(sdkError) };
							break;
						}
						// Fallback when the CLI delivered the message without stream events.
						if (!sawStreamContent) {
							for (const block of (message as any).message?.content ?? []) {
								if (block?.type === "text") addCompletedText(block.text ?? "");
							}
							sawStreamContent = output.content.length > 0;
						}
						break;
					}
					case "result": {
						inputChannel.close();
						const result = message as any;
						if (result.usage) resultUsage = result.usage;
						if (failure) break;
						if (result.subtype === "success") {
							if (!sawStreamContent) addCompletedText(String(result.result ?? ""));
						} else if (result.subtype === "error_max_turns") {
							// Should not happen with every tool disabled; if the model still
							// tried one, the text it produced is the summary.
							debug("one-shot summary: result error_max_turns; delivering the text received");
						} else {
							const lines = Array.isArray(result.errors) ? uniqueNonEmptyLines(result.errors) : [];
							const text = lines.length > 0 ? lines.join("\n") : String(result.result || result.subtype || "Claude Code request failed");
							failure = { kind: isUsageLimitMessage(message) ? "rate-limit" : classifyClaudeFailure(text), message: text };
						}
						break;
					}
					case "rate_limit_event": {
						const info = (message as any).rate_limit_info as Record<string, unknown> | undefined;
						if (info?.status === "rejected") {
							const type = String(info.rateLimitType ?? info.rate_limit_type ?? "unknown");
							failure = { kind: "rate-limit", message: `${type} rate limit`, rateLimited: true };
							if (account && router) router.recordRateLimit(account.profileId, info, model.id);
						}
						break;
					}
					default:
						break;
				}
			}
		} catch (error) {
			// The SDK throws its friendly wrapper after a rejected rate_limit_event or
			// error result; the structured failure recorded above is the better copy.
			if (!aborted) {
				failure ??= { kind: classifyClaudeFailure(error), message: error instanceof Error ? error.message : String(error) };
			}
		}

		if (aborted || options?.signal?.aborted) {
			debug("one-shot summary: aborted");
			fail("Operation aborted", "aborted");
			return;
		}
		if (failure) {
			debug(`one-shot summary: failed (${failure.kind ?? "unclassified"}): ${failure.message.slice(0, 200)}`);
			// Rate limits were recorded from the event itself. Pi retries the
			// summarization on its own (retryAssistantCall); no rotation here.
			if (account && router && failure.kind && !failure.rateLimited) {
				router.recordFailure(account.profileId, failure.kind, model.id);
			}
			fail(failure.message);
			return;
		}

		const usage = resultUsage ?? streamedUsage;
		output.usage.input = usage.input_tokens ?? 0;
		output.usage.output = usage.output_tokens ?? 0;
		output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
		output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
		output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		calculateCost(model, output.usage);
		debug(`one-shot summary: done, chars=${output.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0)} in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} stop=${output.stopReason}`);
		finish();
	}
}
