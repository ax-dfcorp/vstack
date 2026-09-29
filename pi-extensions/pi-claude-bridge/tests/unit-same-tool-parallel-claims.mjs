import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processStreamEvent } from "../src/index.ts";
import { ctx, resetStack, TOOL_CLAIM_GRACE_MS } from "../src/query-state.ts";
import { jsonSchemaToZodShape, validateAgainstShape } from "../src/typebox-to-zod.ts";
import { mapToolArgs } from "../src/tool-mapping.ts";

process.env.CLAUDE_BRIDGE_DIAG_PATH ??= `${process.cwd()}/.test-output/unit-same-tool-claims-diag.log`;

// Two calls of the same tool in one assistant message (2026-09-29 live repro:
// two mcpScript calls) used to lose their pairing: with two same-name
// candidates and no exact args match the claim refused, both handlers errored
// into the child, and pi's real results were dropped as stale. Two causes:
//   - the model added a key the schema does not declare (`timeout` on
//     mcpScript), which the SDK's z.object() strips from the handler copy;
//   - the SDK dispatches the MCP call before the bridge has processed the
//     stream events that finalize the record.

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-fable-5-1",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolNames = new Map([["mcp__custom-tools__mcpScript", "mcpScript"], ["mcp__custom-tools__read", "read"]]);

// The shape pi-mcp-adapter registers for mcpScript.
const mcpScriptSchema = {
	type: "object",
	properties: {
		code: { type: "string" },
		timeoutMs: { type: "number", minimum: 1 },
	},
	required: ["code"],
};
const mcpScriptShape = jsonSchemaToZodShape(mcpScriptSchema);
const normalizeRecorded = (recorded) => {
	const validated = validateAgainstShape(mcpScriptShape, recorded);
	return validated ? mapToolArgs("mcpScript", validated) : undefined;
};
/** What the MCP handler receives: the SDK validates with z.object(shape). */
const handlerArgs = (raw) => mapToolArgs("mcpScript", validateAgainstShape(mcpScriptShape, raw));

function installFakeStream() {
	const events = [];
	ctx().currentPiStream = {
		push(event) { events.push(event); },
		end() { events.push({ type: "stream_end" }); },
	};
	return events;
}

function streamEvent(event) {
	processStreamEvent({ type: "stream_event", event }, toolNames, model);
}

function startBlock(index, id, name = "mcp__custom-tools__mcpScript") {
	streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
}

function finishBlock(index, input) {
	streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
	streamEvent({ type: "content_block_stop", index });
}

function beginMessage() {
	const c = ctx();
	c.resetTurnState(model);
	installFakeStream();
	streamEvent({ type: "message_start", message: { id: "msg_same_tool", usage: { input_tokens: 10, output_tokens: 1 } } });
	return c;
}

/** Let resolved promises run their continuations. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("same-tool parallel calls pair with their own tool_use", () => {
	beforeEach(() => resetStack());

	it("pairs the 2026-09-29 repro: both records final, schema strips the model's extra key", async () => {
		const c = beginMessage();
		const rawA = { code: "emit(await tools.a())", timeout: 60000 };
		const rawB = { code: "emit(await tools.b())", timeout: 60000 };
		startBlock(0, "toolu_A");
		finishBlock(0, rawA);
		startBlock(1, "toolu_B");
		finishBlock(1, rawB);

		// Without normalization this was the refusal: neither record equals the
		// stripped handler copy, and there are two candidates.
		assert.equal(c.claimToolCall("mcpScript", handlerArgs(rawB)).match, "none");

		const claimB = await c.claimToolCallWhenSettled("mcpScript", handlerArgs(rawB), { normalizeRecorded });
		const claimA = await c.claimToolCallWhenSettled("mcpScript", handlerArgs(rawA), { normalizeRecorded });
		assert.equal(claimB.toolCallId, "toolu_B");
		assert.equal(claimB.match, "tool-args");
		assert.equal(claimB.waited, undefined, "an exact match on a final record claims at once");
		assert.equal(claimA.toolCallId, "toolu_A");
		assert.equal(claimA.match, "tool-args");
	});

	it("waits for the second record to finalize instead of guessing, then pairs both", async () => {
		const c = beginMessage();
		const rawA = { code: "emit(1)" };
		const rawB = { code: "emit(2)" };
		startBlock(0, "toolu_A");
		finishBlock(0, rawA);
		startBlock(1, "toolu_B"); // record holds {} until content_block_stop

		let claimB;
		const pendingB = c.claimToolCallWhenSettled("mcpScript", handlerArgs(rawB), { normalizeRecorded }).then((claim) => { claimB = claim; });
		await flush();
		assert.equal(claimB, undefined, "A is final and different, B is still open: the handler must wait");
		assert.equal(c.claimedToolCallIds.size, 0, "nothing claimed while waiting");

		const claimA = await c.claimToolCallWhenSettled("mcpScript", handlerArgs(rawA), { normalizeRecorded });
		assert.equal(claimA.toolCallId, "toolu_A");

		finishBlock(1, rawB);
		await pendingB;
		assert.equal(claimB.toolCallId, "toolu_B");
		assert.equal(claimB.match, "tool-args");
		assert.equal(claimB.waited, true);
	});

	it("waits for a call the bridge has not recorded yet rather than taking a same-name sibling", async () => {
		const c = beginMessage();
		const rawA = { code: "emit('a')" };
		const rawB = { code: "emit('b')" };
		startBlock(0, "toolu_A"); // open: the sibling a guess would take

		let claimB;
		const pendingB = c.claimToolCallWhenSettled("mcpScript", handlerArgs(rawB), { normalizeRecorded }).then((claim) => { claimB = claim; });
		await flush();
		assert.equal(claimB, undefined);

		finishBlock(0, rawA);
		await flush();
		assert.equal(claimB, undefined, "A finalized with different args: still not B's call");
		startBlock(1, "toolu_B");
		finishBlock(1, rawB);
		await pendingB;
		assert.equal(claimB.toolCallId, "toolu_B");
		assert.equal(c.claimedToolCallIds.has("toolu_A"), false, "A stays free for its own handler");
	});

	it("identical-args duplicates: first unclaimed wins and neither is claimed twice", async () => {
		const c = beginMessage();
		const raw = { path: "README.md" };
		startBlock(0, "toolu_1", "mcp__custom-tools__read");
		finishBlock(0, raw);
		startBlock(1, "toolu_2", "mcp__custom-tools__read");
		finishBlock(1, raw);

		const first = await c.claimToolCallWhenSettled("read", mapToolArgs("read", raw));
		const second = await c.claimToolCallWhenSettled("read", mapToolArgs("read", raw));
		assert.equal(first.toolCallId, "toolu_1");
		assert.equal(first.ambiguous, true);
		assert.equal(second.toolCallId, "toolu_2");
		assert.equal(second.ambiguous, false);
		assert.notEqual(first.toolCallId, second.toolCallId);
	});

	it("refuses when several finalized same-name records differ from the handler's args", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = beginMessage();
		startBlock(0, "toolu_A");
		finishBlock(0, { code: "emit('a')" });
		startBlock(1, "toolu_B");
		finishBlock(1, { code: "emit('b')" });

		let claim;
		const pending = c.claimToolCallWhenSettled("mcpScript", { code: "emit('c')" }, { normalizeRecorded }).then((result) => { claim = result; });
		await flush();
		assert.equal(claim, undefined);
		t.mock.timers.tick(TOOL_CLAIM_GRACE_MS);
		await pending;
		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		assert.equal(claim.available, 2);
		assert.equal(c.claimedToolCallIds.size, 0, "no candidate was cross-paired");
	});

	it("keeps waiting while the stream is still producing events, then settles", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = beginMessage();
		startBlock(0, "toolu_A");
		finishBlock(0, { code: "emit('a')" });
		startBlock(1, "toolu_B");
		finishBlock(1, { code: "emit('b')" });

		let claim;
		const pending = c.claimToolCallWhenSettled("mcpScript", { code: "emit('c')" }, { normalizeRecorded }).then((result) => { claim = result; });
		// A later block keeps streaming through the first grace period.
		streamEvent({ type: "content_block_start", index: 2, content_block: { type: "text" } });
		streamEvent({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "still going" } });
		t.mock.timers.tick(TOOL_CLAIM_GRACE_MS);
		await flush();
		assert.equal(claim, undefined, "stream activity during the grace period re-arms the wait");
		t.mock.timers.tick(TOOL_CLAIM_GRACE_MS);
		await pending;
		assert.equal(claim.match, "none");
	});

	it("still claims a sole same-name call after settling, reporting the recorded keys", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = beginMessage();
		startBlock(0, "toolu_A");
		finishBlock(0, { code: "emit('a')", timeoutMs: 5 });

		let claim;
		const pending = c.claimToolCallWhenSettled("mcpScript", { code: "emit('other')" }, { normalizeRecorded }).then((result) => { claim = result; });
		t.mock.timers.tick(TOOL_CLAIM_GRACE_MS);
		await pending;
		assert.equal(claim.toolCallId, "toolu_A");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.argsMismatch, true);
		assert.deepEqual(claim.recordedArgKeys, ["code", "timeoutMs"]);
	});

	it("a sole call whose handler arrives before content_block_stop claims as soon as it finalizes", async () => {
		const c = beginMessage();
		const raw = { code: "emit('only')" };
		startBlock(0, "toolu_only");
		const pending = c.claimToolCallWhenSettled("mcpScript", handlerArgs(raw), { normalizeRecorded });
		finishBlock(0, raw);
		const claim = await pending;
		assert.equal(claim.toolCallId, "toolu_only");
		assert.equal(claim.match, "tool-args");
	});
});
