/**
 * Pi 0.86+ TranscriptContext compatibility.
 *
 * pi-ai 0.86 changed the provider contract: `streamSimple(model, context)` now
 * receives `{ messages }` with the system prompt and tool declarations folded
 * into a leading `role: "system"` message (and later system messages patching
 * prompt sections or the tool set). The bridge reads `context.systemPrompt`
 * (AGENTS.md/memory/skills forwarding) and `context.tools` (the MCP tool set),
 * and counts `context.messages` for session cursors. Without normalization a
 * 0.86+ host ran Claude Code with no Pi tools, no forwarded prompt blocks, and
 * every cursor shifted by the system messages.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeContext } from "@earendil-works/pi-ai";

import { resolveMcpTools } from "../src/index.ts";
import { toLegacyContext, withoutSystemMessages } from "../src/transcript-context.ts";

const tool = (name, description = `${name} tool`) => ({
	name,
	description,
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
});

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "pi-claude",
	model: "claude-fable-5-1",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 2,
});

const legacy = () => ({
	systemPrompt: "You are Pi.\n\n# Project memory\nremember this\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n</available_skills>",
	tools: [tool("read"), tool("bash"), tool("edit")],
	messages: [user("hello"), assistant("hi"), user("list your tools")],
});

describe("toLegacyContext", () => {
	it("passes a Pi <=0.85 context through unchanged", () => {
		const context = legacy();
		assert.equal(toLegacyContext(context), context);
	});

	it("recovers the prompt, tools, and message list from a normalized transcript", () => {
		const original = legacy();
		const adapted = toLegacyContext(normalizeContext(original));
		assert.equal(adapted.systemPrompt, original.systemPrompt);
		assert.deepEqual(adapted.tools.map((t) => t.name), ["read", "bash", "edit"]);
		assert.deepEqual(adapted.messages, original.messages);
		assert.equal(adapted.messages.length, original.messages.length);
	});

	it("gives the bridge the same MCP tool set on both context shapes", () => {
		const before = resolveMcpTools(legacy()).mcpTools.map((t) => t.name);
		const after = resolveMcpTools(toLegacyContext(normalizeContext(legacy()))).mcpTools.map((t) => t.name);
		assert.equal(after.length, 3);
		assert.deepEqual(after, before);
	});

	it("applies mid-conversation system messages and drops every system message from the list", () => {
		const transcript = {
			messages: [
				{ role: "system", content: "", sections: { preamble: "base", skills: "<skills>old</skills>" }, toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
				user("first"),
				assistant("ok"),
				{ role: "system", content: "", sections: { skills: "<skills>new</skills>" }, toolsAdded: [tool("write")], toolsRemoved: [{ name: "bash" }], timestamp: 3 },
				user("second"),
			],
		};
		const adapted = toLegacyContext(transcript);
		assert.equal(adapted.systemPrompt, "base\n\n<skills>new</skills>");
		assert.deepEqual(adapted.tools.map((t) => t.name), ["read", "write"]);
		assert.deepEqual(adapted.messages.map((m) => m.role), ["user", "assistant", "user"]);
	});

	it("is idempotent, so re-entrant provider calls can pass the adapted context again", () => {
		const adapted = toLegacyContext(normalizeContext(legacy()));
		assert.equal(toLegacyContext(adapted), adapted);
	});

	it("leaves a transcript with neither prompt nor tools as a plain message list", () => {
		const adapted = toLegacyContext(normalizeContext({ messages: [user("hi")] }));
		assert.equal(adapted.systemPrompt, undefined);
		assert.equal(adapted.tools, undefined);
		assert.deepEqual(adapted.messages, [user("hi")]);
	});
});

describe("withoutSystemMessages", () => {
	it("keeps session-context cursors on the provider's message numbering", () => {
		const messages = [
			{ role: "system", content: "prompt", timestamp: 0 },
			user("a"),
			{ role: "system", content: "", sections: { cwd: "/x" }, timestamp: 1 },
			assistant("b"),
		];
		assert.deepEqual(withoutSystemMessages(messages).map((m) => m.role), ["user", "assistant"]);
	});

	it("returns the same array when there is nothing to drop", () => {
		const messages = [user("a"), assistant("b")];
		assert.equal(withoutSystemMessages(messages), messages);
	});
});
