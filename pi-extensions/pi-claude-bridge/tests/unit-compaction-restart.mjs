/**
 * Compaction inside a tool loop restarts the live query on the compacted history.
 *
 * Pi's threshold auto-compaction can fire between a tool result and the next
 * model request. The bridge's live query is then still running on the
 * pre-compaction transcript; delivering the tool results into it kept the model
 * on the full history, so pi re-compacted after every tool round (three ~920k
 * summary calls in a row, 2026-09-23). The provider now discards that query and
 * re-runs the turn through a rebuilt session instead. Only a compaction or tree
 * rewrite does this: an ordinary delivery and an abort-marked rebuild keep the
 * normal delivery path. The first query of a fresh pi session has no shared
 * session yet, so the rewrite is recorded on the live query and the session is
 * created from the child's id at teardown.
 *
 * Drives the real streamClaudeAgentSdk against a fake SDK query that blocks
 * until closed, the way a child waiting on an MCP handler does. No API calls.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "claude-bridge-compaction-restart-test-"));
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(scratch, "diag.log");
process.env.PI_CODING_AGENT_DIR = scratch;
const claudeConfigDir = join(scratch, "claude-profile");
const cwd = join(scratch, "project");
mkdirSync(cwd);

const { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, markHistoryRewrite, streamClaudeAgentSdk } = await import("../src/index.ts");
const { CLAUDE_ACCOUNT_ROUTER_SYMBOL } = await import("../src/account-router.ts");
const { isCompactionRebuild } = await import("../src/bridge-state.ts");
const { ctx, isTurnContinuation, resetStack, toolCallDrainCause } = await import("../src/query-state.ts");

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const OLD_SESSION_ID = "0157bd00-0000-4000-8000-000000000000";
const TOOL_CALL_ID = "toolu_compaction_restart";
const TOOL_ARGS = { command: "echo hi" };

const promptContext = { messages: [{ role: "user", content: "run it", timestamp: 1 }] };
const toolResultContext = {
	messages: [
		{ role: "user", content: "run it", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "bash", arguments: TOOL_ARGS }],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse", timestamp: 2,
		},
		{ role: "toolResult", toolCallId: TOOL_CALL_ID, toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false, timestamp: 3 },
	],
};

const account = { profileId: "a", label: "account-a", configDir: claudeConfigDir };
const router = {
	version: 1,
	acquire() { return account; },
	recordIdentity() {},
	recordUsage() {},
	recordRateLimit() { return Date.now() + 60_000; },
	recordFailure(profileId, kind) { observed.failures.push({ profileId, kind }); },
	recordSuccess() {},
	current() { return undefined; },
};

let observed;

function sdkQuery(messages, { blockUntilClosed }) {
	let release;
	const closedSignal = new Promise((resolve) => { release = resolve; });
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) return;
				yield message;
			}
			if (blockUntilClosed) await closedSignal;
		},
		close() {
			if (closed) return;
			closed = true;
			observed.closes += 1;
			release();
		},
		async interrupt() { this.close(); },
		async accountInfo() { return { email: "a@example.com", subscriptionType: "max" }; },
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
			return { subscription_type: "max", rate_limits_available: true, rate_limits: null };
		},
	};
}

// First query: the live tool-loop query, blocked on its MCP handler.
// Any later query: the re-run, which answers and ends.
function installFactory({ liveInit = true } = {}) {
	__testSetSdkQueryFactory((input) => {
		observed.queries.push({ resume: input.options.resume });
		if (observed.queries.length === 1) {
			return sdkQuery(liveInit ? [{ type: "system", subtype: "init", session_id: OLD_SESSION_ID }] : [], { blockUntilClosed: true });
		}
		return sdkQuery([
			{ type: "system", subtype: "init", session_id: input.options.resume ?? "fresh-session" },
			{ type: "result", subtype: "success", result: "continued on the compacted history" },
		], { blockUntilClosed: false });
	});
}

/** Starts the live query and parks one MCP handler on it, like a child that
 *  issued a tool call and is waiting for pi to run it. */
async function startToolLoopQuery() {
	streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: "pi-session" });
	// Let the consumer read the init message, as it has long before pi compacts.
	await new Promise((resolve) => setImmediate(resolve));
	const live = ctx();
	assert.ok(live.activeQuery, "the fresh query did not claim the context");
	live.recordToolCall(TOOL_CALL_ID, "bash", TOOL_ARGS);
	const handlerResult = new Promise((resolve) => {
		live.pendingToolCalls.set(TOOL_CALL_ID, {
			toolName: "bash",
			resolve: (result) => {
				live.markToolResultResolved(TOOL_CALL_ID);
				resolve(result);
			},
		});
	});
	return { live, handlerResult };
}

function setSession(extra) {
	__testSetBridgeIntegrityState({
		sharedSession: { sessionId: OLD_SESSION_ID, cursor: 1, cwd, accountProfileId: account.profileId, claudeConfigDir, ...extra },
	});
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function discardLiveQuery(live) {
	live.activeQuery?.close();
	await live.waitForQuerySettlement();
}

beforeEach(() => {
	observed = { queries: [], closes: 0, failures: [] };
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	installFactory();
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	__testSetSdkQueryFactory();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("compaction during an active query", () => {
	it("discards the live query, drains its handlers as compaction-restart, and re-runs the turn through a session_compact rebuild", async () => {
		const { handlerResult } = await startToolLoopQuery();
		setSession({ needsRebuild: true, rebuildReason: "session_compact" });

		const events = await collect(streamClaudeAgentSdk(model, toolResultContext, { cwd, sessionId: "pi-session" }));

		// The tool result was never delivered into the live query: its handler got
		// the restart error, not pi's "hi".
		const drained = await handlerResult;
		assert.equal(drained.isError, true);
		assert.match(drained.content[0].text, /restarted on the compacted history/);
		assert.ok(observed.closes >= 1, "the live query was not closed");

		// The re-run is a fresh query on a rebuilt, rotated session.
		assert.equal(observed.queries.length, 2);
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "session_compact");
		assert.equal(session.lastSync.rotated, true);
		assert.ok(observed.queries[1].resume, "the re-run did not resume the rebuilt session");
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID);
		assert.equal(session.needsRebuild, undefined);

		// And pi receives the re-run's answer, not an empty orphan end_turn.
		assert.deepEqual(
			events.filter((event) => event.type === "text_delta").map((event) => event.delta),
			["continued on the compacted history"],
		);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(events.at(-1).type, "done");
		assert.deepEqual(observed.failures, [], "a deliberate restart was recorded as an account failure");
	});

	it("restarts the first query of a fresh pi session and rebuilds its child session with the compaction reason", async () => {
		const { live, handlerResult } = await startToolLoopQuery();
		assert.equal(__testGetBridgeIntegrityState().sharedSession, null);
		assert.equal(live.childSessionId, OLD_SESSION_ID);

		markHistoryRewrite("session_compact");
		assert.equal(live.pendingHistoryRewrite, "session_compact");
		assert.equal(__testGetBridgeIntegrityState().sharedSession, null, "markHistoryRewrite invented a shared session");

		const events = await collect(streamClaudeAgentSdk(model, toolResultContext, { cwd, sessionId: "pi-session" }));

		const drained = await handlerResult;
		assert.equal(drained.isError, true);
		assert.match(drained.content[0].text, /restarted on the compacted history/);
		assert.equal(observed.queries.length, 2);
		// Teardown recorded the child session as due for the compaction rebuild
		// (forceRotate): the re-run rebuilt it with that reason and a fresh id.
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "session_compact");
		assert.equal(session.lastSync.rotated, true);
		assert.equal(session.accountProfileId, account.profileId);
		assert.equal(session.claudeConfigDir, claudeConfigDir);
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID);
		assert.deepEqual(
			events.filter((event) => event.type === "text_delta").map((event) => event.delta),
			["continued on the compacted history"],
		);
		assert.equal(events.at(-1).type, "done");
	});

	it("falls back to a first-turn rebuild when the live query never reported its session id", async () => {
		installFactory({ liveInit: false });
		const { live, handlerResult } = await startToolLoopQuery();
		assert.equal(live.childSessionId, undefined);

		markHistoryRewrite("session_compact");
		const events = await collect(streamClaudeAgentSdk(model, toolResultContext, { cwd, sessionId: "pi-session" }));

		assert.equal((await handlerResult).isError, true);
		assert.equal(observed.queries.length, 2);
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "first");
		assert.equal(events.at(-1).type, "done");
	});

	it("restarts for a session_tree rewrite too", () => {
		assert.equal(isCompactionRebuild({ sessionId: "s", cursor: 0, cwd, needsRebuild: true, rebuildReason: "session_tree" }), true);
		assert.equal(isCompactionRebuild({ sessionId: "s", cursor: 0, cwd, needsRebuild: true, rebuildReason: "session_compact" }), true);
	});

	it("delivers tool results into the live query as before when no rebuild is pending", async () => {
		const { live, handlerResult } = await startToolLoopQuery();
		setSession({});

		streamClaudeAgentSdk(model, toolResultContext, { cwd, sessionId: "pi-session" });

		const delivered = await handlerResult;
		assert.equal(delivered.isError, false);
		assert.deepEqual(delivered.content, [{ type: "text", text: "hi" }]);
		assert.equal(observed.queries.length, 1, "a normal delivery started a new query");
		assert.equal(live.compactionRestartRequested, false);
		await discardLiveQuery(live);
	});

	it("keeps the delivery path for a rebuild marked by something other than a history rewrite", async () => {
		assert.equal(isCompactionRebuild({ sessionId: "s", cursor: 0, cwd, needsRebuild: true, rebuildReason: "abort" }), false);
		assert.equal(isCompactionRebuild({ sessionId: "s", cursor: 0, cwd, needsRebuild: false, rebuildReason: "session_compact" }), false);
		assert.equal(isCompactionRebuild(null), false);

		const { live, handlerResult } = await startToolLoopQuery();
		setSession({ needsRebuild: true, forceRotate: true, rebuildReason: "abort" });

		streamClaudeAgentSdk(model, toolResultContext, { cwd, sessionId: "pi-session" });

		const delivered = await handlerResult;
		assert.equal(delivered.isError, false);
		assert.equal(observed.queries.length, 1);
		assert.equal(live.compactionRestartRequested, false);
		await discardLiveQuery(live);
	});
});

describe("compaction-restart cause", () => {
	beforeEach(() => resetStack());

	it("is a continuation, not an abort orphan", () => {
		const c = ctx();
		c.lastQueryEndCause = "compaction-restart";
		assert.equal(isTurnContinuation(c, "toolResult"), true);
	});

	it("ranks below an abort and above a stream-idle timeout", () => {
		assert.equal(toolCallDrainCause({ compactionRestart: true }), "compaction-restart");
		assert.equal(toolCallDrainCause({ compactionRestart: true, wasAborted: true }), "abort");
		assert.equal(toolCallDrainCause({ compactionRestart: true, streamIdleTimedOut: true }), "compaction-restart");
	});
});
