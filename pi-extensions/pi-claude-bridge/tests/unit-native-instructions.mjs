/**
 * Claude Code 2.1.277+ attaches AGENTS.md itself (`cc-plugin-agents-md@builtin`)
 * on top of the chain the bridge forwards in the system prompt, so every Claude
 * session carried its AGENTS.md twice. The bridge limits the CLI loader to
 * CLAUDE.md files, but only for sessions that do not already carry native
 * instruction files: switching it off on such a session makes the CLI announce
 * "Instructions no longer present" and the model drops rules that are still in
 * its system prompt (measured 2026-11-07).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { getSessionPath, normalizeProjectPath } from "cc-session-io";
import { NATIVE_AGENTS_MD_PLUGIN, nativeInstructionSettings } from "../src/agents-md.ts";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { appendPromptSnapshotRecord, nativeInstructionFiles, syncSharedSession } from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-native-instructions-"));
const cwd = join(root, "project");

beforeEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	delete process.env.CLAUDE_BRIDGE_ISOLATED;
});
after(() => rmSync(root, { recursive: true, force: true }));

const shared = () => __testGetBridgeIntegrityState().sharedSession;

function history(turns) {
	const timestamp = Date.now();
	const messages = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: `prompt ${i}`, timestamp });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], stopReason: "stop", timestamp });
	}
	return messages;
}

const instructions = (files, extra = {}) => ({ type: "attachment", attachment: { type: "instructions", files: files.map((path) => ({ path, type: "Project", content: "x" })), ...extra } });

describe("nativeInstructionFiles", () => {
	it("tracks the first full list, later deltas, and removals", () => {
		assert.deepEqual([...nativeInstructionFiles([])], []);
		assert.deepEqual([...nativeInstructionFiles([instructions(["/a/AGENTS.md"])])], ["/a/AGENTS.md"]);
		assert.deepEqual(
			[...nativeInstructionFiles([instructions(["/a/AGENTS.md"]), instructions(["/b/AGENTS.md"], { changed: true })])].sort(),
			["/a/AGENTS.md", "/b/AGENTS.md"],
		);
		assert.deepEqual(
			[...nativeInstructionFiles([instructions(["/a/AGENTS.md"]), instructions([], { changed: true, removed: ["/a/AGENTS.md"], reason: "session_start" })])],
			[],
		);
		// A full (non-delta) attachment replaces what came before.
		assert.deepEqual([...nativeInstructionFiles([instructions(["/a/AGENTS.md"]), instructions(["/c/CLAUDE.md"])])], ["/c/CLAUDE.md"]);
		assert.deepEqual([...nativeInstructionFiles([instructions([])])], []);
	});
});

describe("nativeInstructionSettings", () => {
	it("limits the CLI loader to CLAUDE.md while the bridge forwards AGENTS.md", () => {
		assert.deepEqual(nativeInstructionSettings(true), {
			pluginConfigs: { [NATIVE_AGENTS_MD_PLUGIN]: { options: { instructionFiles: "claude-md" } } },
		});
		assert.equal(NATIVE_AGENTS_MD_PLUGIN, "cc-plugin-agents-md@builtin");
	});
	it("leaves the CLI loader alone when the bridge forwards nothing", () => {
		assert.deepEqual(nativeInstructionSettings(false), {});
		process.env.CLAUDE_BRIDGE_ISOLATED = "1";
		try { assert.deepEqual(nativeInstructionSettings(true), {}); } finally { delete process.env.CLAUDE_BRIDGE_ISOLATED; }
	});
});

describe("syncSharedSession reports native instruction files per session", () => {
	it("is false on a clean start", () => {
		const result = syncSharedSession([{ role: "user", content: "hi", timestamp: Date.now() }], cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(result.nativeInstructions, false);
	});

	it("is true on reuse of a transcript the CLI attached AGENTS.md to, false for one without", () => {
		// First turn with prior history: rebuilt from pi history, no native records.
		const first = syncSharedSession([...history(1), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(first.nativeInstructions, false);
		const sessionId = first.sessionId;
		const reused = syncSharedSession([...history(1), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(reused.sessionId, sessionId);
		assert.equal(reused.nativeInstructions, false);
	});

	it("reads a resumed transcript's own attachments", () => {
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const path = getSessionPath(sessionId, normalizeProjectPath(cwd), undefined);
		mkdirSync(join(path, ".."), { recursive: true });
		const user = { type: "user", uuid: "u1", parentUuid: null, sessionId, message: { role: "user", content: "prompt 0" } };
		const attachment = { ...instructions([join(cwd, "AGENTS.md")]), uuid: "a1", parentUuid: "u1", sessionId };
		const assistant = { type: "assistant", uuid: "m1", parentUuid: "a1", sessionId, message: { id: "msg1", role: "assistant", content: [{ type: "text", text: "answer 0" }] } };
		writeFileSync(path, [user, attachment, assistant].map((record) => JSON.stringify(record)).join("\n") + "\n");
		assert.ok(appendPromptSnapshotRecord(path, sessionId, { type: "prompt_snapshot", systemPrompt: ["core", "# CLAUDE.md\n\nx"] }));
		__testSetBridgeIntegrityState({ sharedSession: { sessionId, cursor: 2, cwd } });
		const reused = syncSharedSession([...history(1), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(reused.sessionId, sessionId);
		assert.equal(reused.nativeInstructions, true);

		// A rebuild that carries the native prefix keeps the attachment, so native loading stays on.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), needsRebuild: true, rebuildReason: "drift" } });
		const rebuilt = syncSharedSession([...history(2), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(shared().lastSync.path, "rebuild");
		assert.ok(shared().lastSync.covered > 0, "the native prefix was carried");
		assert.equal(rebuilt.nativeInstructions, true);

		// A full rewrite from pi history drops native records, so the limit applies from then on.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), needsRebuild: true, rebuildReason: "session_compact" } });
		const compacted = [{ role: "user", content: "summary of earlier work", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now() }, { role: "user", content: "next", timestamp: Date.now() }];
		const rewritten = syncSharedSession(compacted, cwd, undefined, "claude-opus-5-5", undefined, 1, "# CLAUDE.md\n\nx");
		assert.equal(shared().lastSync.covered, 0);
		assert.equal(rewritten.nativeInstructions, false);
	});
});
