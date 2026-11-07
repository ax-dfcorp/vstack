// One idle cache warm-up: after `afterMinutes` of silence following the last
// real top-level request, for a large conversation with no running query and a
// routable account, through a resumed non-persisted copy of the shared session.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __testKeepWarm, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { lastTopLevelRequest, setLastTopLevelRequest } from "../src/bridge-state.ts";
import { DEFAULT_KEEP_WARM, KEEP_WARM_PROMPT, KeepWarmScheduler, keepWarmRefusal, keepWarmSettings } from "../src/keep-warm.ts";
import { normalizeKeepWarm } from "../src/config.ts";
import { buildModels } from "../src/models.ts";
import { clearSideQuestionBase } from "../src/side-question.ts";
import { resetStack } from "../src/query-state.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";

const MIN = 60_000;
const SESSION = { sessionId: "aaaaaaaa-2222-4333-8444-555555555555", cursor: 4, cwd: "/repo", accountProfileId: "a", claudeConfigDir: "/profiles/a" };
const REQUEST = { at: 0, model: "claude-opus-5-5", contextTokens: 250_000, accountProfileId: "a", claudeConfigDir: "/profiles/a", routerSessionId: "pi-1" };
const BASE = { model: "claude-opus-5-5", cwd: "/repo", claudeConfigDir: "/profiles/a" };

function state(patch = {}) {
	return { settings: DEFAULT_KEEP_WARM, lastRequest: REQUEST, liveQuery: false, session: SESSION, base: BASE, accountRoutable: true, warms: 0, now: 53 * MIN, ...patch };
}

describe("keepWarmRefusal", () => {
	it("is due 53 minutes after a large request on an idle, routable session", () => assert.equal(keepWarmRefusal(state()), undefined));
	const cases = [
		["disabled", { settings: { ...DEFAULT_KEEP_WARM, enabled: false } }],
		["already warmed", { warms: 1 }],
		["no request", { lastRequest: null }],
		["small context", { lastRequest: { ...REQUEST, contextTokens: 99_999 } }],
		["too early", { now: 52 * MIN }],
		["cache already gone", { now: 61 * MIN }],
		["running query", { liveQuery: true }],
		["no session", { session: null }],
		["rebuild pending", { session: { ...SESSION, needsRebuild: true } }],
		["no base", { base: null }],
		["base on another model", { base: { ...BASE, model: "claude-fable-5-1" } }],
		["moved session", { base: { ...BASE, claudeConfigDir: "/profiles/b" } }],
		["request on another account", { lastRequest: { ...REQUEST, accountProfileId: "b" } }],
		["blocked account", { accountRoutable: false }],
	];
	for (const [name, patch] of cases) it(`refuses: ${name}`, () => assert.ok(keepWarmRefusal(state(patch))));
	it("allows a session without a router", () => assert.equal(keepWarmRefusal(state({ accountRoutable: undefined })), undefined));
});

describe("settings", () => {
	it("defaults and bounds", () => {
		assert.deepEqual(keepWarmSettings(undefined), { enabled: true, afterMinutes: 53, minContextTokens: 100000, maxWarms: 1 });
		assert.deepEqual(normalizeKeepWarm({ enabled: false, afterMinutes: 90, minContextTokens: "5000", maxWarms: 2.7 }), { enabled: false, afterMinutes: 59, minContextTokens: 5000, maxWarms: 2 });
		assert.deepEqual(normalizeKeepWarm({ afterMinutes: 0 }), { afterMinutes: 1 });
		assert.equal(normalizeKeepWarm({}), undefined);
		assert.equal(normalizeKeepWarm("x"), undefined);
	});
	it("bridge models carry no prompt-cache lifetime, so Pi core's own warmer never fires for them", () => {
		for (const model of buildModels([{ id: "claude-opus-5-5", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1, maxTokens: 1, promptCache: { short: 300, long: 3600 } }])) {
			assert.equal(model.promptCache, undefined);
		}
	});
});

describe("KeepWarmScheduler", () => {
	function harness(overrides = {}) {
		let now = 0;
		const timers = [];
		const calls = { warms: 0, warmed: [], failed: [] };
		let current = { lastRequest: REQUEST, liveQuery: false, session: SESSION, base: BASE, accountRoutable: true };
		const scheduler = new KeepWarmScheduler({
			settings: () => overrides.settings ?? DEFAULT_KEEP_WARM,
			state: () => current,
			warm: async () => { calls.warms++; if (overrides.fail) throw new Error("boom"); return { input: 3, output: 2, cacheRead: 250000, cacheWrite: 40 }; },
			onWarmed: (usage, request) => calls.warmed.push({ usage, request }),
			onFailed: (error) => calls.failed.push(error.message),
			now: () => now,
			setTimer: (callback, ms) => { const timer = { callback, at: now + ms, cleared: false }; timers.push(timer); return timer; },
			clearTimer: (timer) => { timer.cleared = true; },
		});
		const advance = async (ms) => {
			now += ms;
			for (const timer of [...timers]) {
				if (!timer.cleared && !timer.fired && timer.at <= now) { timer.fired = true; timer.callback(); await new Promise((r) => setImmediate(r)); }
			}
		};
		return { scheduler, calls, advance, timers, setState: (patch) => { current = { ...current, ...patch }; }, setNow: (value) => { now = value; } };
	}

	it("warms once, 53 minutes after the last request, and records the usage", async () => {
		const h = harness();
		h.scheduler.noteRequest(REQUEST);
		assert.equal(h.timers[0].at, 53 * MIN);
		await h.advance(52 * MIN);
		assert.equal(h.calls.warms, 0);
		await h.advance(MIN);
		assert.equal(h.calls.warms, 1);
		assert.equal(h.calls.warmed[0].usage.cacheRead, 250000);
		assert.equal(h.scheduler.status().armed, false, "maxWarms 1: no second timer");
		await h.advance(60 * MIN);
		assert.equal(h.calls.warms, 1);
	});

	it("a new request restarts the stretch; a running query or blocked account sends nothing", async () => {
		const h = harness();
		h.scheduler.noteRequest(REQUEST);
		await h.advance(30 * MIN);
		h.scheduler.noteRequest({ ...REQUEST, at: 30 * MIN });
		h.setState({ lastRequest: { ...REQUEST, at: 30 * MIN } });
		await h.advance(23 * MIN);
		assert.equal(h.calls.warms, 0, "measured from the newer request");
		h.setState({ liveQuery: true });
		await h.advance(30 * MIN);
		assert.equal(h.calls.warms, 0);
		const blocked = harness();
		blocked.setState({ accountRoutable: false });
		blocked.scheduler.noteRequest(REQUEST);
		await blocked.advance(53 * MIN);
		assert.equal(blocked.calls.warms, 0);
	});

	it("a second warm-up, when allowed, is measured from the first", async () => {
		const h = harness({ settings: { ...DEFAULT_KEEP_WARM, maxWarms: 2 } });
		h.scheduler.noteRequest(REQUEST);
		await h.advance(53 * MIN);
		assert.equal(h.calls.warms, 1);
		await h.advance(52 * MIN);
		assert.equal(h.calls.warms, 1);
		await h.advance(MIN);
		assert.equal(h.calls.warms, 2);
	});

	it("cancel clears the timer; a failure is reported and not retried", async () => {
		const h = harness();
		h.scheduler.noteRequest(REQUEST);
		h.scheduler.cancel();
		await h.advance(60 * MIN);
		assert.equal(h.calls.warms, 0);
		const f = harness({ fail: true });
		f.scheduler.noteRequest(REQUEST);
		await f.advance(53 * MIN);
		assert.deepEqual(f.calls.failed, ["boom"]);
		await f.advance(60 * MIN);
		assert.equal(f.calls.warms, 1);
	});
});

describe("through the provider", () => {
	beforeEach(() => {
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
		resetStack();
		__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	});
	afterEach(() => {
		delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
		delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
		__testSetSdkQueryFactory();
		__testKeepWarm().cancel();
		clearSideQuestionBase();
		setLastTopLevelRequest(null);
		resetStack();
	});

	it("a top-level request records its context size and arms the warm-up", async () => {
		const model = { id: "claude-haiku-5-5", name: "Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 64000 };
		__testSetSdkQueryFactory(() => {
			const messages = [
				{ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" },
				{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, output_tokens: 1 } } } },
				{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
				{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
				{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
				{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
				{ type: "stream_event", event: { type: "message_stop" } },
				{ type: "assistant", message: { id: "m1", model: model.id, content: [{ type: "text", text: "hi" }] } },
				{ type: "result", subtype: "success", result: "hi", usage: { input_tokens: 2, output_tokens: 1 } },
			];
			let closed = false;
			return { async *[Symbol.asyncIterator]() { for (const m of messages) { if (closed) return; yield m; } }, close() { closed = true; }, async interrupt() {}, async accountInfo() { return {}; } };
		});
		const stream = streamClaudeAgentSdk(model, { systemPrompt: "", messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { sessionId: "pi-1" });
		for await (const _event of stream) { /* drain */ }
		assert.equal(lastTopLevelRequest?.contextTokens, 150502);
		assert.equal(lastTopLevelRequest?.routerSessionId, "pi-1");
		assert.equal(__testKeepWarm().status().armed, true);
	});

	it("the warm-up prompt asks for nothing but an acknowledgement", () => {
		assert.ok(KEEP_WARM_PROMPT.includes("not a message from the user"));
		assert.ok(KEEP_WARM_PROMPT.includes("Do not call any tools"));
	});
});
