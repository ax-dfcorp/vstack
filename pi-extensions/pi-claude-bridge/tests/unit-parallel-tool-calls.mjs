import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent, endToolUseTurn } from "../src/index.ts";
import { ctx, resetStack, failUndeliveredPendingToolCalls, isUndeliverableToolCall } from "../src/query-state.ts";

// A model that issues several tool calls in one message streams them as
// consecutive tool_use blocks. The SDK yields a per-block partial copy of the
// assistant message (and Claude Code may invoke the MCP handler) as soon as the
// FIRST block completes — while the later blocks are still streaming. The grace
// timer armed at that point must not cut them off (2026-09-02: Fable 5.1 turns
// ended with the last call's arguments as `{}` or with the call missing
// entirely, after which the child waited 47 minutes for a result pi could never
// produce).

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-fable-5-1",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolNames = new Map([["mcp__custom-tools__bash", "bash"], ["mcp__custom-tools__read", "read"]]);

function installFakeStream() {
	const events = [];
	const stream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	ctx().currentPiStream = stream;
	return events;
}

function streamEvent(event) {
	processStreamEvent({ type: "stream_event", event }, toolNames, model);
}

/** Stream a complete tool_use block at `index` and yield the SDK's per-block
 *  partial assistant copy, which is what arms the grace timer. */
function streamFirstBlock(id, command) {
	streamEvent({ type: "message_start", message: { id: "msg_parallel", usage: { input_tokens: 10, output_tokens: 1 } } });
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__bash", input: {} } });
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) } });
	streamEvent({ type: "content_block_stop", index: 0 });
	processAssistantMessage({
		type: "assistant",
		message: { id: "msg_parallel", content: [{ type: "tool_use", id, name: "mcp__custom-tools__bash", input: { command } }] },
	}, model, toolNames);
}

describe("parallel tool calls: grace timer never cuts a block that is still streaming", () => {
	beforeEach(() => resetStack());

	it("re-arms while later blocks keep streaming and ends normally at message_stop with every call complete", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();

		streamFirstBlock("toolu_1", "echo one");
		assert.ok(c.scheduledToolUseEnd, "first block arms the grace timer");

		// Second block starts 1s later and streams its arguments slowly.
		t.mock.timers.tick(1000);
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "mcp__custom-tools__bash", input: {} } });
		t.mock.timers.tick(1000); // original 1.5s grace has elapsed — activity seen, must re-arm
		assert.ok(c.currentPiStream, "turn must stay open while a block is streaming");
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ec" } });
		t.mock.timers.tick(1400);
		assert.ok(c.currentPiStream, "still open: deltas keep arriving");
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "ho two\"}" } });
		t.mock.timers.tick(1400);
		assert.ok(c.currentPiStream, "still open after the second delta");
		streamEvent({ type: "content_block_stop", index: 1 });
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } });
		streamEvent({ type: "message_stop" });

		assert.equal(c.currentPiStream, null, "message_stop ends the turn");
		assert.equal(c.scheduledToolUseEnd, null);
		const calls = c.turnBlocks.filter((b) => b.type === "toolCall");
		assert.deepEqual(calls.map((b) => b.arguments.command), ["echo one", "echo two"], "both calls reach pi with full arguments");
		assert.ok(calls.every((b) => !("partialJson" in b)), "no block left unsealed");
		assert.equal(c.wasToolCallDeliveredToPi("toolu_1"), true);
		assert.equal(c.wasToolCallDeliveredToPi("toolu_2"), true);
		assert.equal(events.at(-2).type, "done");
		assert.equal(events.at(-2).message.usage.output, 42, "message_delta usage still lands");
	});

	it("defers a silent stream with an open block up to the cap, then seals the partial arguments instead of shipping {}", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();

		streamFirstBlock("toolu_1", "echo one");
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "mcp__custom-tools__bash", input: {} } });
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo two\"}" } });
		// Then the stream dies: no content_block_stop, no terminal events.

		t.mock.timers.tick(1500); // activity since arming → re-arm
		assert.ok(c.currentPiStream);
		for (let i = 0; i < 6; i++) {
			t.mock.timers.tick(1500); // quiet, block open → deferral
			assert.ok(c.currentPiStream, `deferral ${i + 1} keeps the turn open`);
		}
		t.mock.timers.tick(1500); // deferral cap reached → forced end

		assert.equal(c.currentPiStream, null, "true deadlock backstop still ends the turn");
		const calls = c.turnBlocks.filter((b) => b.type === "toolCall");
		assert.deepEqual(calls.map((b) => b.arguments.command), ["echo one", "echo two"], "open block sealed from its partial JSON");
		assert.ok(calls.every((b) => !("partialJson" in b)));
		assert.equal(events.filter((e) => e.type === "toolcall_end").length, 2, "sealed block gets its toolcall_end");
		assert.equal(c.wasToolCallDeliveredToPi("toolu_2"), true);
		assert.equal(events.at(-2).type, "done");
		assert.equal(events.at(-2).reason, "toolUse");
	});

	it("still force-ends a quiet stream with no open blocks after one grace period", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		streamFirstBlock("toolu_1", "echo one");
		t.mock.timers.tick(1500);

		assert.equal(c.currentPiStream, null, "the pi 0.80 steer-draining backstop is preserved");
		assert.equal(c.wasToolCallDeliveredToPi("toolu_1"), true);
	});
});

describe("parallel tool calls: a call pi never received fails fast instead of waiting forever", () => {
	beforeEach(() => resetStack());

	it("flags a tool_use that arrives after the pi turn ended as undeliverable", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		streamFirstBlock("toolu_1", "echo one");
		endToolUseTurn(c);
		assert.equal(c.currentPiStream, null);
		assert.equal(c.wasToolCallDeliveredToPi("toolu_1"), true);

		// The SDK's completed copy of the same message carries the later calls.
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_parallel", stop_reason: "tool_use", content: [
				{ type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__bash", input: { command: "echo one" } },
				{ type: "tool_use", id: "toolu_2", name: "mcp__custom-tools__bash", input: { command: "echo two" } },
				{ type: "tool_use", id: "toolu_3", name: "mcp__custom-tools__read", input: { file_path: "x.txt" } },
			] },
		}, model, toolNames);

		assert.equal(c.hasRecordedToolCall("toolu_2"), true, "still recorded so the handler's claim resolves to a real id");
		assert.equal(isUndeliverableToolCall(c, "toolu_1"), false);
		assert.equal(isUndeliverableToolCall(c, "toolu_2"), true);
		assert.equal(isUndeliverableToolCall(c, "toolu_3"), true);

		// Even after pi's next call opened a new stream, the flag holds.
		installFakeStream();
		assert.equal(isUndeliverableToolCall(c, "toolu_2"), true);
	});

	it("fails only the waiting handlers whose call pi never received", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		streamFirstBlock("toolu_1", "echo one");
		endToolUseTurn(c);

		const outcomes = new Map();
		for (const [id, toolName] of [["toolu_1", "bash"], ["toolu_2", "bash"], ["toolu_3", "read"]]) {
			c.pendingToolCalls.set(id, { toolName, resolve: (result) => outcomes.set(id, result) });
		}

		const failed = failUndeliveredPendingToolCalls(c);

		assert.deepEqual(failed.map((f) => f.id), ["toolu_2", "toolu_3"]);
		assert.equal(c.pendingToolCalls.size, 1, "the delivered call keeps waiting for pi's real result");
		assert.ok(c.pendingToolCalls.has("toolu_1"));
		assert.equal(outcomes.has("toolu_1"), false);
		assert.equal(outcomes.get("toolu_2").isError, true);
		assert.match(outcomes.get("toolu_2").content[0].text, /not delivered to Pi/);
		assert.match(outcomes.get("toolu_3").content[0].text, /read call/);
	});
});
