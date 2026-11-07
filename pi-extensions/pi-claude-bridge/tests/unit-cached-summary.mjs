// A compaction summary is written by the conversation's own resumed session
// while its prompt cache is warm (one model turn, not persisted, tools denied),
// and by the isolated one-shot query otherwise or whenever that attempt fails.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setLastTopLevelRequest } from "../src/bridge-state.ts";
import {
	CACHED_SUMMARY_MAX_IDLE_MS,
	CACHED_SUMMARY_MIN_CONTEXT_WITH_SUBSTITUTE,
	buildCachedSummaryPrompt,
	conversationDigestOf,
	takeCompactionNote,
	cachedSummaryOptions,
	cachedSummaryRefusal,
	describeBoundaryMessage,
	noteCompaction,
	summaryInstructions,
} from "../src/cached-summary.ts";
import { clearSideQuestionBase, recordSideQuestionBase } from "../src/side-question.ts";
import { resetStack } from "../src/query-state.ts";

const model = {
	id: "claude-haiku-5-5", name: "Claude Haiku 5.5", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge",
	reasoning: true, input: ["text"], cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 1000000, maxTokens: 64000,
};

const PI_SUMMARY_PROMPT = "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n...\n\n## Critical Context\n- ...\n\nKeep each section concise.";
const PI_UPDATE_PROMPT = "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\nUpdate the existing structured summary ...\n\n## Critical Context\n- ...";
const SYSTEM = "You are a context summarization assistant. ONLY output the structured summary.";

function summaryContext(text) {
	return { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
}
const initialPrompt = `<conversation>\n[User]: hello\n\n[Assistant]: hi\n</conversation>\n\n${PI_SUMMARY_PROMPT}\n\nAdditional focus: the API work`;
// The messages Pi summarizes for that prompt.
const SUMMARIZED = [
	{ role: "user", content: "hello", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "hi" }], api: "x", provider: "x", model: "x", stopReason: "stop", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
];

function textMessages(text, { toolUse = false, stop = "end_turn" } = {}) {
	return [
		{ type: "system", subtype: "init", session_id: "s" },
		{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 5, cache_read_input_tokens: 200000, cache_creation_input_tokens: 300 } } } },
		...(toolUse
			? [{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__read", input: {} } } }]
			: [
				{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
				{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
				{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			]),
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 40 } } },
		{ type: "result", subtype: "success", result: text, usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 200000, cache_creation_input_tokens: 300 } },
	];
}

function fakeQuery(messages, observed) {
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() { for (const message of messages) { if (closed) return; yield message; } },
		close() { closed = true; observed.closes += 1; },
		async interrupt() {},
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const SESSION = { sessionId: "11111111-2222-4333-8444-555555555555", cursor: 10, cwd: "/repo", accountProfileId: "a", claudeConfigDir: "/profiles/a" };

function warmState({ idleMs = 60_000, lastModel = model.id } = {}) {
	__testSetBridgeIntegrityState({ sharedSession: { ...SESSION } });
	recordSideQuestionBase({
		model: model.id, cwd: "/repo", claudeConfigDir: "/profiles/a",
		buildOptions: () => ({ model: model.id, cwd: "/repo", effort: "high", env: { CLAUDE_CONFIG_DIR: "/profiles/a" }, systemPrompt: { type: "preset", preset: "claude_code", snapshot: true }, mcpServers: { "custom-tools": {} }, includePartialMessages: true }),
	});
	setLastTopLevelRequest({ at: Date.now() - idleMs, model: lastModel, contextTokens: 200000, accountProfileId: "a", claudeConfigDir: "/profiles/a" });
	noteCompaction({ conversationDigest: conversationDigestOf(SUMMARIZED), reason: "threshold", isSplitTurn: false, boundary: 'your reply that begins "hi"', inSync: true, at: Date.now() });
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	__testSetSdkQueryFactory();
	clearSideQuestionBase();
	setLastTopLevelRequest(null);
	noteCompaction(null);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("matching a summary request to its compaction", () => {
	it("hashes the text Pi serializes for the summarized messages", () => {
		const note = { conversationDigest: conversationDigestOf(SUMMARIZED), reason: "manual", isSplitTurn: false, boundary: "b", inSync: true, at: 0 };
		assert.ok(note.conversationDigest);
		noteCompaction(note);
		assert.equal(takeCompactionNote(initialPrompt), note);
		assert.equal(takeCompactionNote(initialPrompt), null, "consumed once");
		noteCompaction(note);
		assert.equal(takeCompactionNote(initialPrompt.replace("hello", "goodbye")), null, "another conversation does not match");
		noteCompaction(note);
		assert.equal(takeCompactionNote("# Conversation\n[User]: hello"), null);
	});
});

describe("summary prompt pieces", () => {
	it("keeps Pi's instructions, previous summary, and focus without the serialized conversation", () => {
		assert.equal(summaryInstructions(initialPrompt), `${PI_SUMMARY_PROMPT}\n\nAdditional focus: the API work`);
		const update = `<conversation>\n[User]: a\n</conversation>\n\n<previous-summary>\n## Goal\nold\n</previous-summary>\n\n${PI_UPDATE_PROMPT}`;
		assert.equal(summaryInstructions(update), `<previous-summary>\n## Goal\nold\n</previous-summary>\n\n${PI_UPDATE_PROMPT}`);
		// A conversation that itself mentions the closing tag still splits at the last one.
		const tricky = `<conversation>\n[User]: what is </conversation>\n\nThe messages above are a conversation to summarize. no\n</conversation>\n\n${PI_SUMMARY_PROMPT}`;
		assert.equal(summaryInstructions(tricky), PI_SUMMARY_PROMPT);
	});
	it("refuses turn-prefix and branch prompts", () => {
		assert.equal(summaryInstructions("# Conversation\n[User]: a\n\n# Instructions\nThe messages above are earlier context"), undefined);
		assert.equal(summaryInstructions("<conversation>\nx\n</conversation>\n\nSummarize this branch."), undefined);
	});
	it("names the boundary message", () => {
		assert.equal(describeBoundaryMessage({ role: "user", content: "please   fix\nthe bug" }), 'the user message that begins "please fix the bug"');
		assert.equal(describeBoundaryMessage({ role: "assistant", content: [{ type: "text", text: "Done." }] }), 'your reply that begins "Done."');
		assert.equal(describeBoundaryMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", name: "read" }] }), "your call to `bash`, `read`");
		assert.equal(describeBoundaryMessage({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] }), 'the result of your `bash` call that begins "ok"');
		assert.ok(describeBoundaryMessage({ role: "user", content: "x".repeat(500) }).length < 200);
		assert.equal(describeBoundaryMessage({ role: "assistant", content: [] }), undefined);
	});
	it("builds a request that scopes the summary and forbids tools", () => {
		const prompt = buildCachedSummaryPrompt(SYSTEM, PI_SUMMARY_PROMPT, 'your reply that begins "hi"');
		assert.ok(prompt.startsWith("<summary_request>"));
		assert.ok(prompt.includes("do not call any tools"));
		assert.ok(prompt.includes(SYSTEM));
		assert.ok(prompt.includes('through your reply that begins "hi". Everything after that message stays in the context verbatim'));
		assert.ok(prompt.includes(PI_SUMMARY_PROMPT));
	});
	it("resumes without persisting, one turn, every tool denied, existing hooks kept", async () => {
		const existing = { hooks: [async () => ({ continue: true })] };
		const options = cachedSummaryOptions({ model: "m", hooks: { PreToolUse: [existing] } }, "sid");
		assert.equal(options.resume, "sid");
		assert.equal(options.persistSession, false);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.model, "m");
		assert.equal(options.hooks.PreToolUse.length, 2);
		assert.equal(options.hooks.PreToolUse[0], existing);
		const verdict = await options.hooks.PreToolUse[1].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Bash" });
		assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
	});
});

describe("cachedSummaryRefusal", () => {
	const ok = {
		note: { conversationDigest: "d", reason: "threshold", isSplitTurn: false, boundary: "b", inSync: true, at: 0 },
		promptText: initialPrompt, liveQuery: false, nested: false,
		session: { ...SESSION }, base: { model: model.id, cwd: "/repo", claudeConfigDir: "/profiles/a" },
		lastRequest: { at: 1_000_000, model: model.id, accountProfileId: "a" }, model: model.id, now: 1_000_000 + 60_000,
	};
	it("accepts the warm, in-sync, idle case", () => assert.equal(cachedSummaryRefusal(ok), undefined));
	const cases = [
		["no note", { note: null }],
		["split turn", { note: { ...ok.note, isSplitTurn: true } }],
		["overflow", { note: { ...ok.note, reason: "overflow" } }],
		["unnamed boundary", { note: { ...ok.note, boundary: undefined } }],
		["out of sync", { note: { ...ok.note, inSync: false } }],
		["turn-prefix prompt", { promptText: "# Conversation\nx" }],
		["live query", { liveQuery: true }],
		["nested", { nested: true }],
		["rebuild pending", { session: { ...SESSION, needsRebuild: true } }],
		["no base", { base: null }],
		["other model last turn", { base: { ...ok.base, model: "claude-opus-5-5" } }],
		["moved account", { base: { ...ok.base, claudeConfigDir: "/profiles/b" } }],
		["last request on another account", { lastRequest: { ...ok.lastRequest, accountProfileId: "b" } }],
		["cold cache", { now: ok.lastRequest.at + CACHED_SUMMARY_MAX_IDLE_MS + 1 }],
	];
	for (const [name, patch] of cases) {
		it(`refuses: ${name}`, () => assert.ok(cachedSummaryRefusal({ ...ok, ...patch })));
	}
});

describe("summary routing through the provider", () => {
	function run(messagesPerQuery) {
		const observed = { queries: [], closes: 0 };
		__testSetSdkQueryFactory(({ prompt, options }) => {
			const index = observed.queries.length;
			observed.queries.push({ options, prompt });
			return fakeQuery(messagesPerQuery[Math.min(index, messagesPerQuery.length - 1)], observed);
		});
		return observed;
	}
	async function promptText(prompt) {
		for await (const message of prompt) return message.message.content.map((block) => block.text).join("");
	}

	it("writes the summary from the resumed session while the cache is warm", async () => {
		warmState();
		const observed = run([textMessages("## Goal\ncached summary")]);
		const events = await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt), { cacheRetention: "none", sessionId: "pi-1" }));
		assert.equal(observed.queries.length, 1);
		const { options, prompt } = observed.queries[0];
		assert.equal(options.resume, SESSION.sessionId);
		assert.equal(options.persistSession, false);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.effort, "high", "the last turn's effort, not a summary override");
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", snapshot: true }, "the conversation's recorded prompt, not Pi's summary prompt");
		const text = await promptText(prompt);
		assert.ok(text.includes('through your reply that begins "hi"'));
		assert.ok(text.includes("Additional focus: the API work"));
		assert.ok(!text.includes("[User]: hello"), "the serialized conversation is not sent again");
		const done = events.find((event) => event.type === "done");
		assert.equal(done.message.content[0].text, "## Goal\ncached summary");
		assert.equal(done.message.usage.cacheRead, 200000);
	});

	for (const [name, first] of [
		["calls a tool", textMessages("", { toolUse: true })],
		["stops at the length limit", textMessages("## Goal\npartial", { stop: "max_tokens" })],
		["fails", [{ type: "result", subtype: "error_during_execution", errors: ["boom"] }]],
		["returns thinking only", [
			{ type: "system", subtype: "init", session_id: "s" },
			{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 5, cache_read_input_tokens: 200000 } } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } } },
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } } },
			{ type: "result", subtype: "success", result: "", usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 200000 } },
		]],
		["ends without a result", textMessages("## Goal\nhalf").slice(0, -1)],
	]) {
		it(`falls back to the one-shot summary when the resumed attempt ${name}`, async () => {
			warmState();
			const observed = run([first, textMessages("## Goal\none-shot summary")]);
			const events = await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt), { cacheRetention: "none", sessionId: "pi-1" }));
			assert.equal(observed.queries.length, 2);
			assert.equal(observed.queries[1].options.resume, undefined);
			assert.equal(observed.queries[1].options.systemPrompt, SYSTEM);
			const visible = events.filter((event) => event.type === "done" || event.type === "error");
			assert.equal(visible.length, 1, "Pi sees one summary");
			assert.equal(visible[0].message.content[0].text, "## Goal\none-shot summary");
		});
	}

	it("leaves a small context to the summary substitute, whose uncached request is cheaper there", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "cached-summary-cfg-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({ provider: { summaryModelOverrides: { [model.id]: { model: "claude-opus-5-5", effort: "high" } } } }));
		try {
			warmState();
			setLastTopLevelRequest({ at: Date.now() - 60_000, model: model.id, contextTokens: CACHED_SUMMARY_MIN_CONTEXT_WITH_SUBSTITUTE - 1, accountProfileId: "a", claudeConfigDir: "/profiles/a" });
			let observed = run([textMessages("## Goal\nx")]);
			await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt), { cacheRetention: "none", sessionId: "pi-1" }));
			assert.equal(observed.queries[0].options.resume, undefined, "small context: the substitute's isolated request");
			warmState();
			setLastTopLevelRequest({ at: Date.now() - 60_000, model: model.id, contextTokens: CACHED_SUMMARY_MIN_CONTEXT_WITH_SUBSTITUTE, accountProfileId: "a", claudeConfigDir: "/profiles/a" });
			observed = run([textMessages("## Goal\nx")]);
			await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt), { cacheRetention: "none", sessionId: "pi-1" }));
			assert.equal(observed.queries[0].options.resume, SESSION.sessionId, "large context: the warm cache");
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("takes the one-shot path when the cache is cold or the request is not the noted compaction's", async () => {
		warmState({ idleMs: CACHED_SUMMARY_MAX_IDLE_MS + 60_000 });
		let observed = run([textMessages("## Goal\nx")]);
		await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt), { cacheRetention: "none", sessionId: "pi-1" }));
		assert.equal(observed.queries[0].options.resume, undefined);
		warmState();
		observed = run([textMessages("## Goal\nx")]);
		await collect(streamClaudeAgentSdk(model, summaryContext(initialPrompt.replace("hello", "a branch")), { cacheRetention: "none", sessionId: "branch-uuid" }));
		assert.equal(observed.queries[0].options.resume, undefined);
	});
});
