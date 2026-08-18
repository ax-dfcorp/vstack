#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	deferredUserPromptToSdkInput,
	extractDeferredUserPrompt,
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
