// A tool_use is handed to Pi only when its exact name is a tool on the bridge's
// MCP server. Any other name is resolved by the child alone: Claude Code either
// rejects it (`No such tool available`, before any hook or handler runs) or runs
// it on a server of its own (a project `.mcp.json`). Mirroring those calls made
// Pi run rejected calls the model never saw the output of, so the model sent them
// again and the command ran twice (148 of 161 rejections in 14 days reached Pi,
// 2026-11-14), and wrote a false `Tool ... not found` for calls the child ran.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { noteChildExecutedToolResults, processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { isPiToolCall, childResolvedOutcome, flushChildResolvedCalls, CHILD_RESOLVED_INTEGRITY_LABEL } from "../src/child-resolved.ts";
import { mapToolName } from "../src/tool-mapping.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";

process.env.CLAUDE_BRIDGE_DIAG_PATH ??= `${process.cwd()}/.test-output/unit-child-resolved-diag.log`;

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-opus-5-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** The query's name map as resolveMcpTools builds it: exact SDK name and a lower-cased alias. */
function toolMap(piNames) {
	const map = new Map();
	for (const name of piNames) {
		const sdk = `mcp__custom-tools__${name}`;
		map.set(sdk, name);
		map.set(sdk.toLowerCase(), name);
	}
	return map;
}

const REGISTERED = ["bash", "read", "edit", "write", "mcpScript", "hym_ops_tools"];

// Rejected-name shapes from the 14-day corpus (2026-10-31..11-14).
const REJECTED_SHAPES = [
	"bash", // bare Pi name: 71 rejections
	"HymDbQuery", // PascalCase guess: 5
	"mcp__custom-tools__mcp__mcpScript", // gateway prefix doubled: 5
	"mcp__custom-tools__hym_db_query", // HYM tool not active yet: 13
	"mcp__custom-tools__Bash", // different casing
];

const REJECTION = (name) => `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`;

let entries;

function installFakeStream() {
	const events = [];
	ctx().currentPiStream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	return events;
}

const streamEvent = (event) => ({ type: "stream_event", event });

function streamToolUse(index, id, name, input, map) {
	processStreamEvent(streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }), map, model);
	processStreamEvent(streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }), map, model);
	processStreamEvent(streamEvent({ type: "content_block_stop", index }), map, model);
}

function childResults(results) {
	return { type: "user", message: { role: "user", content: results.map(({ id, text, isError }) => ({ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) })) } };
}

const integrity = () => entries.filter((entry) => entry.customType === "claude-bridge-integrity" && entry.data.label === CHILD_RESOLVED_INTEGRITY_LABEL).map((entry) => entry.data);

beforeEach(() => {
	resetStack();
	entries = [];
	setExtensionApi({ appendEntry(customType, data) { entries.push({ customType, data }); } });
});

afterEach(() => setExtensionApi(undefined));

describe("isPiToolCall", () => {
	it("accepts exactly the registered SDK names", () => {
		const map = toolMap(REGISTERED);
		for (const name of REGISTERED) assert.equal(isPiToolCall(`mcp__custom-tools__${name}`, map), true, name);
	});

	it("refuses every rejected shape, other servers, and connectors", () => {
		const map = toolMap(REGISTERED);
		for (const name of [...REJECTED_SHAPES, "mcp__custom-tools__mcpscript", "Bash", "read", "mcp__paseo__browser_fill", "mcp__localsrv__ping", "mcp__claude_ai_Slack__slack_read_channel", "", undefined]) {
			assert.equal(isPiToolCall(name, map), false, String(name));
		}
		assert.equal(isPiToolCall("mcp__custom-tools__bash", undefined), false);
	});
});

describe("childResolvedOutcome", () => {
	it("tells a rejection, an error, and a result apart", () => {
		assert.equal(childResolvedOutcome({ is_error: true, content: REJECTION("bash") }), "rejected");
		assert.equal(childResolvedOutcome({ is_error: true, content: [{ type: "text", text: REJECTION("HymDbQuery") }] }), "rejected");
		assert.equal(childResolvedOutcome({ is_error: true, content: "server failed" }), "error");
		assert.equal(childResolvedOutcome({ content: [{ type: "text", text: "pong" }] }), "ran");
	});
});

describe("a call whose name is not on the bridge's tool server", () => {
	it("is never mirrored to Pi on the streamed path; a qualified call in the same message is, under its own id", () => {
		const map = toolMap(REGISTERED);
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 1 } } }), map, model);
		REJECTED_SHAPES.forEach((name, index) => streamToolUse(index, `toolu_rej_${index}`, name, { command: "echo once" }, map));
		streamToolUse(REJECTED_SHAPES.length, "toolu_ok", "mcp__custom-tools__bash", { command: "echo once" }, map);

		const piCalls = c.turnBlocks.filter((block) => block.type === "toolCall");
		assert.deepEqual(piCalls.map((block) => [block.id, block.name]), [["toolu_ok", "bash"]]);
		assert.deepEqual(c.turnToolCallIds, ["toolu_ok"], "Pi must owe a result for the qualified call only");
		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 1);
		assert.deepEqual([...c.childResolvedCalls.keys()], REJECTED_SHAPES.map((_, index) => `toolu_rej_${index}`));
	});

	it("is never mirrored from the SDK's completed message or the no-stream fallback", () => {
		const map = toolMap(REGISTERED);
		const content = REJECTED_SHAPES.map((name, index) => ({ type: "tool_use", id: `toolu_rej_${index}`, name, input: {} }));
		// Completed copy after stream events (appendMissingToolUsesFromAssistant).
		let c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 1, output_tokens: 1 } } }), map, model);
		processAssistantMessage({ type: "assistant", message: { id: "msg_2", content } }, model, map);
		assert.equal(c.turnBlocks.filter((block) => block.type === "toolCall").length, 0);
		assert.equal(c.turnSawToolCall, false, "a message of child-resolved calls is not a Pi turn boundary");
		// Fallback without any stream event.
		resetStack();
		c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processAssistantMessage({ type: "assistant", message: { id: "msg_3", content } }, model, map);
		assert.equal(c.turnBlocks.filter((block) => block.type === "toolCall").length, 0);
		assert.equal(c.turnSawToolCall, false);
		assert.equal(c.childResolvedCalls.size, REJECTED_SHAPES.length);
	});

	it("records one integrity entry per call with the child's outcome, never the payload, and keeps the turn open", () => {
		const map = toolMap(REGISTERED);
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_4", usage: { input_tokens: 1, output_tokens: 1 } } }), map, model);
		REJECTED_SHAPES.forEach((name, index) => streamToolUse(index, `toolu_rej_${index}`, name, {}, map));
		streamToolUse(5, "toolu_native", "mcp__localsrv__ping", { word: "hi" }, map);
		processStreamEvent(streamEvent({ type: "message_stop" }), map, model);
		assert.notEqual(c.currentPiStream, null, "the Pi turn must stay open while the child resolves the calls");

		const results = [
			...REJECTED_SHAPES.map((name, index) => ({ id: `toolu_rej_${index}`, text: REJECTION(name), isError: true })),
			{ id: "toolu_native", text: "pong hi secret-payload" },
		];
		noteChildExecutedToolResults(childResults(results));
		noteChildExecutedToolResults(childResults(results)); // the SDK may re-yield a user message

		const recorded = integrity();
		assert.deepEqual(recorded.map(({ name, toolUseId, outcome }) => ({ name, toolUseId, outcome })), [
			...REJECTED_SHAPES.map((name, index) => ({ name, toolUseId: `toolu_rej_${index}`, outcome: "rejected" })),
			{ name: "mcp__localsrv__ping", toolUseId: "toolu_native", outcome: "ran" },
		]);
		assert.equal(JSON.stringify(entries).includes("secret-payload"), false, "the payload must never be recorded");
		assert.equal(JSON.stringify(entries).includes("echo"), false, "arguments must never be recorded");
		assert.equal(entries.some((entry) => entry.customType === "claude-bridge-connector-call"), false, "not a connector call");
	});

	it("records a call whose result never came back as unobserved at teardown, once", () => {
		const map = toolMap(REGISTERED);
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		streamToolUse(0, "toolu_lost", "mcp__localsrv__slow", {}, map);
		assert.equal(flushChildResolvedCalls(c, "abort"), 1);
		assert.equal(flushChildResolvedCalls(c, "abort"), 0);
		assert.deepEqual(integrity().map(({ outcome, reason }) => ({ outcome, reason })), [{ outcome: "unobserved", reason: "abort" }]);
	});
});

describe("calls to registered tools are unchanged", () => {
	it("mirrors 100 qualified calls, including a tool registered live mid-turn, with the same ids and names", () => {
		const map = toolMap(REGISTERED);
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_5", usage: { input_tokens: 1, output_tokens: 1 } } }), map, model);
		const expected = [];
		for (let i = 0; i < 100; i++) {
			if (i === 50) {
				// What registerActivatedTools adds to the query's map when a loader activates a tool.
				map.set("mcp__custom-tools__hym_db_query", "hym_db_query");
				map.set("mcp__custom-tools__hym_db_query".toLowerCase(), "hym_db_query");
			}
			const piName = i >= 50 && i % 5 === 0 ? "hym_db_query" : REGISTERED[i % REGISTERED.length];
			const sdkName = `mcp__custom-tools__${piName}`;
			streamToolUse(i, `toolu_q_${i}`, sdkName, { n: i }, map);
			expected.push([`toolu_q_${i}`, mapToolName(sdkName, map)]);
		}
		const piCalls = c.turnBlocks.filter((block) => block.type === "toolCall");
		assert.deepEqual(piCalls.map((block) => [block.id, block.name]), expected);
		assert.deepEqual(piCalls.map((block) => block.arguments.n), Array.from({ length: 100 }, (_, i) => i));
		assert.equal(c.childResolvedCalls.size, 0);
		assert.equal(piCalls.filter((block) => block.name === "hym_db_query").length, 10);
	});
});
