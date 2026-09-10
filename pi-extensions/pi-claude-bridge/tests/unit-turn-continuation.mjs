/**
 * Continuation vs. abort orphan, and the live-steer injection gate.
 *
 * A provider call arriving with a tool-result tail and no active query means
 * one of two opposite things. pi's agent loop is
 * `for (await agent.prompt(); await handlePostAgentRun(); ) await continue()`,
 * and BOTH overflow auto-compaction and auto-retry strip the failed assistant
 * message before continuing — so the continuation re-enters the provider with
 * the tool result still at the tail, indistinguishable from the result an
 * aborted turn left behind unless the reason the last query ended is recorded.
 *
 * Treating every such call as an orphan is what produced the empty
 * `stopReason: "stop"` assistant message that appeared in the local session
 * history right after each mid-task compaction, ending the run silently and
 * forcing the prompt to be retyped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "claude-bridge-continuation-test-"));
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(scratch, "diag.log");
process.env.PI_CODING_AGENT_DIR = scratch;

const { ctx, canInjectSteer, isTurnContinuation, resetStack } = await import("../src/query-state.js");
const { createQueryInputChannel } = await import("../src/input-channel.js");
const { teardownQuery } = await import("../src/query-teardown.js");

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("isTurnContinuation", () => {
	beforeEach(() => resetStack());

	it("treats a tool-result tail after a plain query end as pi continuing the turn", () => {
		const c = ctx();
		c.lastQueryEndCause = "query-end";
		assert.equal(isTurnContinuation(c, "toolResult"), true);
	});

	it("treats a tool-result tail after a stream-idle timeout as a continuation too", () => {
		// pi's auto-retry path strips the errored assistant message and calls
		// continue(); the tail is real work waiting to resume.
		const c = ctx();
		c.lastQueryEndCause = "stream-idle-timeout";
		assert.equal(isTurnContinuation(c, "toolResult"), true);
	});

	it("keeps an aborted turn's orphaned result an orphan", () => {
		const c = ctx();
		c.lastQueryEndCause = "abort";
		assert.equal(isTurnContinuation(c, "toolResult"), false);
	});

	it("keeps an orphan during the abort window before teardown recorded a cause", () => {
		const c = ctx();
		c.abortRequested = true;
		c.lastQueryEndCause = null;
		assert.equal(isTurnContinuation(c, "toolResult"), false);
	});

	it("never fires for a user prompt or any other tail", () => {
		const c = ctx();
		c.lastQueryEndCause = "query-end";
		assert.equal(isTurnContinuation(c, "user"), false);
		assert.equal(isTurnContinuation(c, "assistant"), false);
		assert.equal(isTurnContinuation(c, undefined), false);
	});

	it("reads the cause teardown recorded, so a compacted turn resumes", () => {
		const c = ctx();
		const sdkQuery = { id: "q1" };
		c.activeQuery = sdkQuery;
		teardownQuery(c, sdkQuery, "query-end", scratch, false);
		assert.equal(c.lastQueryEndCause, "query-end");
		assert.equal(isTurnContinuation(c, "toolResult"), true);
	});

	it("clears the recorded cause when the next query starts", () => {
		const c = ctx();
		c.lastQueryEndCause = "abort";
		c.beginQuerySettlement();
		assert.equal(c.lastQueryEndCause, null);
		assert.equal(c.abortRequested, false);
	});
});

describe("canInjectSteer", () => {
	beforeEach(() => resetStack());

	function armLiveQuery() {
		const c = ctx();
		c.inputChannel = createQueryInputChannel([{ type: "text", text: "prompt" }]);
		c.pendingToolCalls.set("toolu_1", { toolName: "bash", resolve() {} });
		return c;
	}

	it("injects while a handler is waiting: the child is blocked on us, so a next model turn is guaranteed", () => {
		assert.equal(canInjectSteer(armLiveQuery(), "user"), true);
	});

	it("refuses with no waiting handler, because no further model turn is guaranteed", () => {
		const c = armLiveQuery();
		c.pendingToolCalls.clear();
		assert.equal(canInjectSteer(c, "user"), false);
	});

	it("refuses once the channel closed at the turn's result", () => {
		const c = armLiveQuery();
		c.inputChannel.close();
		assert.equal(canInjectSteer(c, "user"), false);
	});

	it("refuses while the query is being aborted", () => {
		const c = armLiveQuery();
		c.abortRequested = true;
		assert.equal(canInjectSteer(c, "user"), false);
	});

	it("refuses when there is no channel (continuation queries use a one-shot prompt)", () => {
		const c = armLiveQuery();
		c.inputChannel = null;
		assert.equal(canInjectSteer(c, "user"), false);
	});

	it("refuses when the tail is not a user message", () => {
		assert.equal(canInjectSteer(armLiveQuery(), "toolResult"), false);
	});

	it("closes and detaches the channel at teardown so a late steer cannot write into a dead query", () => {
		const c = armLiveQuery();
		const channel = c.inputChannel;
		const sdkQuery = { id: "q1" };
		c.activeQuery = sdkQuery;
		teardownQuery(c, sdkQuery, "query-end", scratch, false);
		assert.equal(channel.closed, true);
		assert.equal(c.inputChannel, null);
		assert.equal(canInjectSteer(c, "user"), false);
	});
});
