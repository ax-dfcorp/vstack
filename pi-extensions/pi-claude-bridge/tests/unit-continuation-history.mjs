/**
 * What the rebuilt Claude session contains when pi continues an interrupted
 * turn instead of sending a new prompt.
 *
 * syncSharedSession assumed the tail was always the new user message and
 * imported `messages.slice(0, -1)`. A continuation's tail is a TOOL RESULT, so
 * that assumption throws away the real result, leaves its tool_use unpaired,
 * and the pairing repair replaces it with a synthetic "lost" error — the model
 * resumes believing its own work failed. dropTrailing=0 keeps the tail.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { openSession } from "cc-session-io";

import { __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { syncSharedSession } from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-continuation-history-"));
const cwd = join(root, "project");

beforeEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => rmSync(root, { recursive: true, force: true }));

const TOOL_CALL_ID = "toolu_continuation_1";
const TOOL_OUTPUT = "build succeeded in 4.2s";

/** A turn interrupted mid-tool-loop: pi already stripped the failed assistant
 *  message, so the tail is the tool result the model has not seen yet. */
function interruptedTurnMessages() {
	const timestamp = Date.now();
	return [
		{ role: "user", content: "ship the release", timestamp },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "bash", arguments: { command: "npm run build" } }],
			stopReason: "toolUse",
			timestamp,
		},
		{ role: "toolResult", toolCallId: TOOL_CALL_ID, content: TOOL_OUTPUT, isError: false, timestamp },
	];
}

function writtenRecords(sessionId) {
	const { jsonlPath } = openSession({ sessionId, projectPath: cwd });
	return readFileSync(jsonlPath, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function toolResultBlocks(records) {
	const blocks = [];
	for (const record of records) {
		const content = record?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "tool_result") blocks.push(block);
		}
	}
	return blocks;
}

describe("continuation history import", () => {
	it("keeps the tool-result tail so the model resumes from its real output", () => {
		const { sessionId } = syncSharedSession(
			interruptedTurnMessages(),
			cwd,
			undefined,
			"claude-opus-4-8",
			undefined,
			0,
		);
		assert.ok(sessionId);
		const results = toolResultBlocks(writtenRecords(sessionId));
		assert.equal(results.length, 1, "the tool_use must be paired with exactly one result");
		assert.equal(results[0].tool_use_id, TOOL_CALL_ID);
		assert.equal(results[0].content, TOOL_OUTPUT);
		assert.notEqual(results[0].is_error, true);
	});

	it("drops it under the normal prompt path, which is why a continuation must not use dropTrailing=1", () => {
		// Documents the failure the parameter exists to avoid: the same history
		// imported as if the tail were a new user prompt loses the real result and
		// the repair layer substitutes a synthetic error.
		const { sessionId } = syncSharedSession(
			interruptedTurnMessages(),
			cwd,
			undefined,
			"claude-opus-4-8",
			undefined,
			1,
		);
		assert.ok(sessionId);
		const results = toolResultBlocks(writtenRecords(sessionId));
		const real = results.find((block) => block.content === TOOL_OUTPUT);
		assert.equal(real, undefined, "the real tool output is not in the rebuilt history");
	});

	it("still treats the tail as the prompt for a normal turn", () => {
		const timestamp = Date.now();
		const { sessionId } = syncSharedSession(
			[
				{ role: "user", content: "first", timestamp },
				{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp },
				{ role: "user", content: "second prompt goes to the SDK, not the transcript", timestamp },
			],
			cwd,
			undefined,
			"claude-opus-4-8",
		);
		assert.ok(sessionId);
		const texts = JSON.stringify(writtenRecords(sessionId));
		assert.equal(texts.includes("second prompt goes to the SDK"), false);
		assert.equal(texts.includes("first"), true);
	});
});
