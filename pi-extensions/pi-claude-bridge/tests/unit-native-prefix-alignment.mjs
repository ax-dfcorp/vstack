// alignNativePrefix: how much of the CLI's own transcript a rebuild may reuse
// verbatim. Cuts only right before a pi user message; stops at the first
// record that is not provably the same conversation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignNativePrefix, appendPromptSnapshotRecord, refreshSnapshotAppend, verifyRecordChain } from "../src/session-persistence.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const user = (text) => ({ type: "user", uuid: `u-${text}`, message: { role: "user", content: text } });
const attachment = (type) => ({ type: "attachment", uuid: `a-${type}`, attachment: { type, text: "<total_tokens>1 tokens left</total_tokens>" } });
const assistantText = (id, text) => ({ type: "assistant", uuid: `as-${id}-t`, message: { id, role: "assistant", content: [{ type: "text", text }] } });
const assistantToolUse = (id, toolId, name = "mcp__custom-tools__bash") => ({ type: "assistant", uuid: `as-${id}-${toolId}`, message: { id, role: "assistant", content: [{ type: "tool_use", id: toolId, name, input: { command: "x" } }] } });
const toolResult = (toolId, text) => ({ type: "user", uuid: `tr-${toolId}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text }] }] } });
const meta = (type) => ({ type, sessionId: "s" });

const piUser = (text) => ({ role: "user", content: text });
const piAssistant = (text, toolIds = []) => ({ role: "assistant", content: [{ type: "text", text }, ...toolIds.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "x" } }))] });
const piToolResult = (id, text) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false });

describe("alignNativePrefix", () => {
	it("carries complete turns, including the CLI's attachments and bookkeeping records, up to the last turn boundary", () => {
		const records = [
			meta("queue-operation"),
			user("first"), attachment("total_tokens_reminder"),
			assistantText("m1", "working"), assistantToolUse("m1", "toolu_1"),
			toolResult("toolu_1", "out"), attachment("total_tokens_reminder"),
			assistantText("m2", "done"),
			meta("last-prompt"),
			user("second"), attachment("total_tokens_reminder"),
			assistantText("m3", "partial"), assistantToolUse("m3", "toolu_2"),
		];
		const messages = [
			piUser("first"),
			piAssistant("working", ["toolu_1"]),
			piToolResult("toolu_1", "out"),
			piAssistant("done"),
			piUser("second"),
			{ role: "assistant", content: [{ type: "text", text: "partial" }, { type: "toolCall", id: "toolu_2", name: "bash", arguments: {} }], stopReason: "aborted" },
		];
		// Everything through "done" is native and complete: 8 records, 4 pi messages.
		// The aborted turn's tool_use has no result, so it is left to the converter.
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 8, messageCount: 4 });
	});

	it("carries an aborted text-only turn at the end, since it is paired and identical", () => {
		const records = [user("q"), assistantText("m1", "a"), user("r"), assistantText("m2", "partial")];
		const messages = [piUser("q"), piAssistant("a"), piUser("r"), { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" }];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 4, messageCount: 4 });
	});

	it("covers the whole history when it ends at a turn boundary", () => {
		const records = [user("q"), assistantText("m1", "a")];
		const messages = [piUser("q"), piAssistant("a")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 2, messageCount: 2 });
	});

	it("stops at the first diverging record: a different tool set", () => {
		const records = [
			user("q"), assistantToolUse("m1", "toolu_1"), toolResult("toolu_1", "o"), assistantText("m2", "a"),
			user("r"), assistantToolUse("m3", "toolu_9"), toolResult("toolu_9", "o"), assistantText("m4", "b"),
		];
		const messages = [
			piUser("q"), piAssistant("", ["toolu_1"]), piToolResult("toolu_1", "o"), piAssistant("a"),
			piUser("r"), piAssistant("", ["toolu_2"]), piToolResult("toolu_2", "o"), piAssistant("b"),
		];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 4, messageCount: 4 });
	});

	it("accepts a native user record that wraps the pi prompt in extra context", () => {
		const records = [
			{ type: "user", uuid: "u", message: { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "hello there" }] } },
			assistantText("m1", "hi"),
		];
		assert.deepEqual(alignNativePrefix(records, [piUser("hello there"), piAssistant("hi")]), { recordCount: 2, messageCount: 2 });
	});

	it("accepts parallel tool results recorded as one grouped user record", () => {
		const records = [
			user("q"),
			assistantToolUse("m1", "toolu_a"), assistantToolUse("m1", "toolu_b"),
			{ type: "user", uuid: "grp", message: { role: "user", content: [
				{ type: "tool_result", tool_use_id: "toolu_a", content: "1" },
				{ type: "tool_result", tool_use_id: "toolu_b", content: "2" },
			] } },
			assistantText("m2", "done"),
		];
		const messages = [piUser("q"), piAssistant("", ["toolu_a", "toolu_b"]), piToolResult("toolu_a", "1"), piToolResult("toolu_b", "2"), piAssistant("done")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 5, messageCount: 5 });
	});

	it("carries nothing after a pi compaction, whose summary is not in the native transcript", () => {
		const records = [user("original prompt"), assistantText("m1", "a")];
		const messages = [piUser("The conversation history was compacted: ..."), piAssistant("a")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 0, messageCount: 0 });
	});

	it("never cuts in the middle of a tool batch", () => {
		const records = [user("q"), assistantToolUse("m1", "toolu_1")];
		const messages = [piUser("q"), piAssistant("", ["toolu_1"]), piToolResult("toolu_1", "o")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 0, messageCount: 0 });
	});

	it("does not cut at a steer that arrived while a tool call was still open", () => {
		const records = [user("q"), assistantToolUse("m1", "toolu_1"), user("steer now")];
		const messages = [piUser("q"), piAssistant("", ["toolu_1"]), piUser("steer now")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 0, messageCount: 0 });
	});

	it("carries a steer between a tool call and its results once the results are paired", () => {
		const records = [user("q"), assistantToolUse("m1", "toolu_1"), user("steer now"), toolResult("toolu_1", "o"), assistantText("m2", "a")];
		const messages = [piUser("q"), piAssistant("", ["toolu_1"]), piUser("steer now"), piToolResult("toolu_1", "o"), piAssistant("a")];
		assert.deepEqual(alignNativePrefix(records, messages), { recordCount: 5, messageCount: 5 });
	});
});

describe("refreshSnapshotAppend", () => {
	const snapshot = { systemPrompt: ["core", "# Environment\n - x", "<total_tokens>15000000 tokens left</total_tokens>", "# CLAUDE.md\n\nold agents text"], tools: [{ name: "t", description: "d" }] };

	it("replaces only the bridge's append block when AGENTS.md changed", () => {
		const out = refreshSnapshotAppend(snapshot, "# CLAUDE.md\n\nnew agents text");
		assert.deepEqual(out.systemPrompt, ["core", "# Environment\n - x", "<total_tokens>15000000 tokens left</total_tokens>", "# CLAUDE.md\n\nnew agents text"]);
		assert.deepEqual(out.tools, snapshot.tools);
	});

	it("is a no-op when the recorded block already matches", () => {
		assert.equal(refreshSnapshotAppend(snapshot, "# CLAUDE.md\n\nold agents text"), undefined);
	});

	it("leaves a snapshot without a recognizable append block alone", () => {
		assert.equal(refreshSnapshotAppend({ systemPrompt: ["core only"] }, "# CLAUDE.md\n\nx"), undefined);
		assert.equal(refreshSnapshotAppend(snapshot, undefined), undefined);
	});
});

describe("verifyRecordChain", () => {
	function write(lines) {
		const dir = mkdtempSync(join(tmpdir(), "chain-"));
		const path = join(dir, "s.jsonl");
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
	}

	it("accepts a file whose chained records all parent to an earlier record", () => {
		const f = write([{ type: "queue-operation" }, { type: "user", uuid: "a", parentUuid: null }, { type: "attachment", uuid: "b", parentUuid: "a" }, { type: "assistant", uuid: "c", parentUuid: "b" }]);
		try { assert.equal(verifyRecordChain(f.path), undefined); } finally { f.cleanup(); }
	});

	it("rejects a converted tail that started a second chain root", () => {
		const f = write([{ type: "user", uuid: "a", parentUuid: null }, { type: "assistant", uuid: "b", parentUuid: "a" }, { type: "user", uuid: "c", parentUuid: null }]);
		try { assert.match(verifyRecordChain(f.path), /second chain root/); } finally { f.cleanup(); }
	});

	it("rejects a dangling parent", () => {
		const f = write([{ type: "user", uuid: "a", parentUuid: null }, { type: "assistant", uuid: "b", parentUuid: "zzz" }]);
		try { assert.match(verifyRecordChain(f.path), /dangling parent/); } finally { f.cleanup(); }
	});

	it("ignores subagent sidechain roots", () => {
		const f = write([{ type: "user", uuid: "a", parentUuid: null }, { type: "user", uuid: "s", parentUuid: null, isSidechain: true }, { type: "assistant", uuid: "b", parentUuid: "a" }]);
		try { assert.equal(verifyRecordChain(f.path), undefined); } finally { f.cleanup(); }
	});

	it("appendPromptSnapshotRecord parents to the last chained record, not to trailing bookkeeping lines", () => {
		const f = write([
			{ type: "user", uuid: "a", parentUuid: null },
			{ type: "assistant", uuid: "b", parentUuid: "a" },
			{ type: "last-prompt", lastPrompt: "x" },
			{ type: "atis-latch", atis: "" },
		]);
		try {
			assert.equal(appendPromptSnapshotRecord(f.path, "sid", { type: "prompt_snapshot", systemPrompt: ["p"] }), true);
			const lines = readFileSync(f.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			const appended = lines.at(-1);
			assert.equal(appended.type, "attachment");
			assert.equal(appended.parentUuid, "b");
			assert.equal(appended.sessionId, "sid");
			assert.equal(verifyRecordChain(f.path), undefined);
		} finally { f.cleanup(); }
	});
});
