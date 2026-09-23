// Pi's compaction and branch summaries reach the provider as a one-off request
// (`cacheRetention: "none"`, one user message, a summarization system prompt).
// They must run as an isolated one-shot query: never as a steer written into a
// live tool-use query (the mid-tool-loop compaction deadlock), never resuming
// the shared Claude session, and never touching the shared cursor.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { createQueryInputChannel } from "../src/input-channel.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const SUMMARY_SYSTEM = "You are a context summarization assistant.";
const summaryContext = {
	systemPrompt: SUMMARY_SYSTEM,
	messages: [{
		role: "user",
		content: [{ type: "text", text: "<conversation>...</conversation>\n\nSummarize the conversation above." }],
		timestamp: Date.now(),
	}],
};

function summaryMessages(text) {
	return [
		{ type: "system", subtype: "init", session_id: "one-shot-session" },
		{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 10, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, 5) } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(5) } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 1 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "assistant", message: { model: model.id, content: [{ type: "thinking", thinking: "plan" }, { type: "text", text }], usage: { input_tokens: 10, output_tokens: 7 } } },
		{
			type: "result", subtype: "success", result: text,
			usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
		},
	];
}

function fakeSdkQuery(messages, observed, { hold = false } = {}) {
	let closed = false;
	let wake = null;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) return;
				yield message;
			}
			// `hold` models a child still sampling: nothing more until closed.
			while (hold && !closed) await new Promise((resolve) => { wake = resolve; });
		},
		close() { closed = true; observed.closes += 1; wake?.(); },
		async interrupt() { observed.interrupts += 1; },
		async accountInfo() { return {}; },
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
	};
}

function makeRouter(observed) {
	return {
		version: 1,
		acquire(input) {
			observed.acquires.push(input);
			return { profileId: "a", label: "account-a", configDir: "/profiles/a" };
		},
		recordIdentity() {},
		recordUsage() {},
		recordRateLimit(profileId, info) { observed.rateLimits.push({ profileId, info }); return Date.now() + 60_000; },
		recordFailure(profileId, kind) { observed.failures.push({ profileId, kind }); },
		recordSuccess(profileId) { observed.successes.push(profileId); },
		current() { return undefined; },
	};
}

function observedState() {
	return { acquires: [], queries: [], closes: 0, interrupts: 0, rateLimits: [], failures: [], successes: [] };
}

async function collect(stream, timeoutMs = 2000) {
	const events = [];
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`stream did not finish within ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		await Promise.race([
			(async () => { for await (const event of stream) events.push(event); })(),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
	return events;
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	__testSetSdkQueryFactory();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("one-shot summary requests (cacheRetention: none)", () => {
	it("builds an isolated query: plain system prompt, no resume, no MCP servers, no tools", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: "main-session", cursor: 4, cwd: process.cwd() } });
		__testSetSdkQueryFactory((input) => {
			observed.queries.push(input);
			return fakeSdkQuery(summaryMessages("## Goal\nsummary"), observed);
		});

		await collect(streamClaudeAgentSdk(model, summaryContext, { cacheRetention: "none", sessionId: "pi-session", reasoning: "high" }));

		assert.equal(observed.queries.length, 1);
		const { options, prompt } = observed.queries[0];
		assert.equal(options.systemPrompt, SUMMARY_SYSTEM);
		assert.equal(options.resume, undefined);
		assert.equal(options.mcpServers, undefined);
		assert.deepEqual(options.tools, []);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.persistSession, false);
		assert.equal(options.settingSources, undefined);
		assert.equal(options.model, model.id);
		assert.equal(options.effort, "high");
		assert.equal(options.extraArgs["thinking-display"], "summarized");
		assert.equal(options.env.CLAUDE_CONFIG_DIR, "/profiles/a");
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(observed.acquires[0].sessionId, "pi-session");

		const sent = [];
		for await (const message of prompt) sent.push(message);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0].message.content, [{ type: "text", text: summaryContext.messages[0].content[0].text }]);
	});

	it("streams the summary to Pi and ends with done, mapping the result usage", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetSdkQueryFactory((input) => {
			observed.queries.push(input);
			return fakeSdkQuery(summaryMessages("## Goal\nsummary"), observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, summaryContext, { cacheRetention: "none" }));
		const types = events.map((event) => event.type);
		assert.equal(types[0], "start");
		assert.deepEqual(types.filter((type) => type.startsWith("thinking_")), ["thinking_start", "thinking_delta", "thinking_end"]);
		assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["## Go", "al\nsummary"]);
		const done = events.at(-1);
		assert.equal(done.type, "done");
		assert.equal(done.reason, "stop");
		assert.equal(done.message.stopReason, "stop");
		assert.deepEqual(done.message.content.map((block) => block.type), ["thinking", "text"]);
		assert.equal(done.message.content[1].text, "## Goal\nsummary");
		assert.equal(done.message.content[0].thinkingSignature, "sig");
		assert.deepEqual(
			{ ...done.message.usage, cost: undefined },
			{ input: 10, output: 7, cacheRead: 2, cacheWrite: 1, totalTokens: 20, cost: undefined },
		);
		assert.ok(done.message.usage.cost.total > 0);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
	});

	it("runs beside a live tool-use query without steering into it or moving the shared cursor", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		const liveChannel = createQueryInputChannel([{ type: "text", text: "main task" }]);
		const pushes = [];
		const originalPush = liveChannel.push.bind(liveChannel);
		liveChannel.push = (blocks) => { pushes.push(blocks); return originalPush(blocks); };
		const liveCtx = ctx();
		const liveStream = { push() {}, end() {} };
		liveCtx.activeQuery = fakeSdkQuery([], observedState(), { hold: true });
		liveCtx.inputChannel = liveChannel;
		liveCtx.currentPiStream = liveStream;
		liveCtx.pendingToolCalls.set("toolu_live", { toolName: "bash", resolve() {} });
		const sharedBefore = { sessionId: "main-session", cursor: 7, cwd: process.cwd() };
		__testSetBridgeIntegrityState({ sharedSession: sharedBefore });
		__testSetSdkQueryFactory((input) => {
			observed.queries.push(input);
			return fakeSdkQuery(summaryMessages("mid-loop summary"), observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, summaryContext, { cacheRetention: "none" }));

		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).message.content.at(-1).text, "mid-loop summary");
		assert.equal(observed.queries.length, 1, "the summary must start its own query");
		assert.equal(pushes.length, 0, "nothing may be written into the live query's input channel");
		assert.equal(liveChannel.injectedCount, 0);
		assert.equal(liveCtx.pendingToolCalls.size, 1);
		assert.equal(ctx(), liveCtx);
		assert.equal(liveCtx.currentPiStream, liveStream);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, { sessionId: "main-session", cursor: 7, cwd: process.cwd() });
	});

	it("leaves requests without cacheRetention on the normal session path", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetSdkQueryFactory((input) => {
			observed.queries.push(input);
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "main-session" },
				{ type: "result", subtype: "success", result: "normal" },
			], observed);
		});

		await collect(streamClaudeAgentSdk(model, summaryContext, {}));

		assert.equal(observed.queries.length, 1);
		const { options } = observed.queries[0];
		assert.equal(options.systemPrompt.type, "preset");
		assert.equal(options.systemPrompt.snapshot, true);
		assert.equal(options.maxTurns, undefined);
		assert.equal(options.persistSession, undefined);
	});

	it("ends with error(aborted) and stops the child when Pi aborts", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetSdkQueryFactory((input) => {
			observed.queries.push(input);
			return fakeSdkQuery([{ type: "system", subtype: "init", session_id: "one-shot-session" }], observed, { hold: true });
		});
		const controller = new AbortController();
		const stream = streamClaudeAgentSdk(model, summaryContext, { cacheRetention: "none", signal: controller.signal });
		setTimeout(() => controller.abort(), 20);

		const events = await collect(stream);
		const last = events.at(-1);
		assert.equal(last.type, "error");
		assert.equal(last.reason, "aborted");
		assert.equal(last.error.stopReason, "aborted");
		assert.ok(observed.closes >= 1, "the child query must be closed");
		assert.ok(observed.interrupts >= 1, "the child query must be interrupted");
		assert.equal(ctx().abortRequested, false, "the shared query context must not see the summary's abort");
		assert.equal(observed.failures.length, 0, "an abort is not an account failure");
	});
});
