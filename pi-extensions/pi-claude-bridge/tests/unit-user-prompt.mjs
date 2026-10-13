#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	deferredUserPromptToSdkInput,
	extractDeferredUserPrompt,
	extractUserPrompt,
	extractUserPromptBlocks,
	trailingUserCount,
} from "../src/user-prompt.js";

async function firstAsyncValue(iterable) {
	for await (const value of iterable) return value;
	throw new Error("Expected one SDK prompt message");
}

describe("deferred user prompts", () => {
	it("keeps text and every image when a steer is replayed after the active query", async () => {
		const deferred = extractDeferredUserPrompt([
			{
				role: "user",
				content: [
					{ type: "text", text: "use these screenshots" },
					{ type: "image", data: "first", mimeType: "image/png" },
					{ type: "image", data: "second", mimeType: "image/jpeg" },
				],
			},
		]);
		assert.ok(deferred);
		assert.equal(deferred.text, "use these screenshots");

		const sdkPrompt = deferredUserPromptToSdkInput(deferred);
		assert.notEqual(typeof sdkPrompt, "string");
		assert.deepEqual((await firstAsyncValue(sdkPrompt)).message.content, [
			{ type: "text", text: "use these screenshots" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "first" },
			},
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "second" },
			},
		]);
	});

	it("keeps text-only continuations on the SDK string prompt path", () => {
		const deferred = extractDeferredUserPrompt([{ role: "user", content: "continue" }]);
		assert.ok(deferred);
		assert.equal(deferredUserPromptToSdkInput(deferred), "continue");
	});

	it("sends every trailing user message, not only the last one (two steers in one tool boundary)", async () => {
		const messages = [
			{ role: "user", content: "original task" },
			{ role: "assistant", content: [{ type: "text", text: "working" }] },
			{ role: "user", content: [{ type: "text", text: "<paseo-system>\nAgent 7011 finished.\n</paseo-system>" }] },
			{ role: "user", content: [{ type: "text", text: "<paseo-system>\nAgent 1932 finished.\n</paseo-system>" }] },
		];
		assert.equal(trailingUserCount(messages), 2);
		assert.equal(
			extractUserPrompt(messages),
			"<paseo-system>\nAgent 7011 finished.\n</paseo-system>\n\n<paseo-system>\nAgent 1932 finished.\n</paseo-system>",
		);
		// Text-only tails stay on the string path; the earlier user turn before the assistant is history.
		assert.equal(extractUserPromptBlocks(messages), null);
		assert.equal(trailingUserCount([{ role: "user", content: "only" }, { role: "assistant", content: [] }]), 0);

		const withImage = [
			{ role: "assistant", content: [{ type: "text", text: "working" }] },
			{ role: "user", content: [{ type: "text", text: "first" }, { type: "image", data: "a", mimeType: "image/png" }] },
			{ role: "user", content: "second" },
		];
		const deferred = extractDeferredUserPrompt(withImage);
		assert.ok(deferred);
		assert.equal(deferred.text, "first\n\nsecond");
		const content = (await firstAsyncValue(deferredUserPromptToSdkInput(deferred))).message.content;
		assert.deepEqual(content.map((block) => block.type), ["text", "image"]);
	});

	it("accepts image-only continuation prompts", async () => {
		const deferred = extractDeferredUserPrompt([
			{
				role: "user",
				content: [{ type: "image", data: "only-image", mimeType: "image/webp" }],
			},
		]);
		assert.ok(deferred);
		const sdkPrompt = deferredUserPromptToSdkInput(deferred);
		assert.notEqual(typeof sdkPrompt, "string");
		const content = (await firstAsyncValue(sdkPrompt)).message.content;
		assert.equal(content.length, 1);
		assert.equal(content[0].type, "image");
		assert.equal(content[0].source.data, "only-image");
	});
});
