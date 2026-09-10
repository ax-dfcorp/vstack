#!/usr/bin/env node
/**
 * End-to-end shape of a resumed turn: does Claude actually pick the work back
 * up from a rebuilt session whose tail is a tool result?
 *
 * This is the second half of the auto-compaction fix. The first half (deciding
 * the call is a continuation, keeping the tool result in the imported history)
 * is unit-tested; this checks the part only the real model can answer — that
 * the rebuilt transcript plus CONTINUATION_PROMPT resumes the task instead of
 * making the model ask what it was doing.
 *
 * Requires: Claude credentials + the Claude Code executable.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { syncSharedSession } from "../src/session-persistence.ts";
import { CONTINUATION_PROMPT } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "claude-int-continuation-"));
const cwd = join(root, "project");
const TOOL_CALL_ID = "toolu_int_continuation_1";
const TOOL_OUTPUT = "alpha.txt\nbravo.txt\ncharlie.txt";

before(() => {
	mkdirSync(cwd, { recursive: true });
	// Real files so the model can finish the task without inventing anything.
	for (const name of ["alpha.txt", "bravo.txt", "charlie.txt"]) {
		writeFileSync(join(cwd, name), "x");
	}
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("continuation against the real model", () => {
	it("resumes the interrupted task from the tool-result tail", { timeout: 120_000 }, async () => {
		const timestamp = Date.now();
		// Exactly the shape pi hands the provider after overflow compaction: the
		// failed assistant message is gone and a tool result is the tail.
		const { sessionId } = syncSharedSession(
			[
				{
					role: "user",
					content: "List the .txt files in this directory, then tell me how many there are.",
					timestamp,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "bash", arguments: { command: "ls *.txt" } }],
					stopReason: "toolUse",
					timestamp,
				},
				{ role: "toolResult", toolCallId: TOOL_CALL_ID, content: TOOL_OUTPUT, isError: false, timestamp },
			],
			cwd,
			undefined,
			"claude-haiku-4-5",
			undefined,
			0,
		);
		assert.ok(sessionId, "expected a rebuilt session");

		let text = "";
		const resumed = query({
			prompt: CONTINUATION_PROMPT,
			options: {
				model: "claude-haiku-4-5",
				cwd,
				resume: sessionId,
				permissionMode: "bypassPermissions",
				systemPrompt: { type: "preset", preset: "claude_code" },
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
			},
		});
		for await (const message of resumed) {
			if (message.type !== "assistant") continue;
			for (const block of message.message.content) {
				if (block.type === "text") text += block.text;
			}
		}

		assert.notEqual(text.trim(), "", "the resumed turn produced no output at all");
		// It should answer the original question from the tool result it can see,
		// rather than asking what the task was.
		assert.match(
			text,
			/\b(3|three)\b/i,
			`resumed turn did not answer from the tool result: ${text.slice(0, 300)}`,
		);
	});
});
