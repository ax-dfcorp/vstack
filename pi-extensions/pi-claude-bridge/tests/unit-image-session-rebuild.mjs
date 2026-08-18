#!/usr/bin/env node

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "cc-session-io";
import { convertPiMessages } from "../src/convert.js";

const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("image session rebuild", () => {
	it("keeps every user image after an interrupted turn is imported", () => {
		const projectPath = mkdtempSync(join(tmpdir(), "pi-claude-image-rebuild-"));
		temporaryDirectories.push(projectPath);
		const { anthropicMessages } = convertPiMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect these screenshots" },
					{ type: "image", mimeType: "image/png", data: "first-image" },
					{ type: "image", mimeType: "image/jpeg", data: "second-image" },
				],
			},
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "partial", thinkingSignature: "" }],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
			},
			{ role: "user", content: "continue" },
		]);
		const session = createSession({
			projectPath,
			claudeDir: join(projectPath, ".claude"),
		});

		session.importMessages(anthropicMessages);
		session.save();

		const messages = session.messages.map((record) => record.message);
		assert.deepEqual(messages[0].content, [
			{ type: "text", text: "inspect these screenshots" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "first-image" },
			},
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "second-image" },
			},
		]);
		assert.equal(
			messages[1].content[0].text,
			"[Previous assistant turn was interrupted before responding]",
		);
		assert.equal(messages[2].content, "continue");
	});
});
