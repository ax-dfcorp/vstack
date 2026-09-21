/**
 * The system-prompt append (AGENTS.md + project memory + skills) is frozen in
 * the CLI's recorded prompt snapshot. A change on disk must reach the model
 * WITHOUT rewriting that snapshot, because the snapshot leads every API
 * request and rewriting it invalidates the whole conversation's prompt cache
 * (every AGENTS.md commit cost a 100-500k re-write per Claude session, 2026-09).
 *
 * Also covers the two inputs of that append that were wrong before 2026-09-22:
 * the project-memory block was never forwarded to Claude at all, and AGENTS.md
 * sanitization rewrote real paths (`~/.pi/agent`, `pi-local`) into ones that do
 * not exist.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { sanitizeAgentsContent } from "../src/agents-md.ts";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { formatAppendUpdate } from "../src/index.ts";
import { getSessionPath, normalizeProjectPath } from "cc-session-io";

import { appendDigest, appendPromptSnapshotRecord, lastPromptSnapshot, readSessionRecords, recordedAppendBlock, syncSharedSession } from "../src/session-persistence.ts";
import { extractMemoryBlock } from "../src/skills.ts";

const root = mkdtempSync(join(tmpdir(), "claude-append-update-"));
const cwd = join(root, "project");

beforeEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => rmSync(root, { recursive: true, force: true }));

const shared = () => __testGetBridgeIntegrityState().sharedSession;
const OLD = "# CLAUDE.md\n\nold instructions";
const NEW = "# CLAUDE.md\n\nnew instructions";

function history(turns, firstPrompt = "prompt 0") {
	const timestamp = Date.now();
	const messages = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: i === 0 ? firstPrompt : `prompt ${i}`, timestamp });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], stopReason: "stop", timestamp });
	}
	return messages;
}

/** Simulate the CLI having recorded its prompt (with the bridge's append block) into the session file. */
function recordSnapshot(sessionId, appendBlock) {
	const path = getSessionPath(sessionId, normalizeProjectPath(cwd), undefined);
	assert.ok(appendPromptSnapshotRecord(path, sessionId, { type: "prompt_snapshot", systemPrompt: ["core prompt", appendBlock] }));
	return path;
}

describe("append changes are delivered in the prompt, not by rewriting the snapshot", () => {
	it("returns the update once on reuse, keeps the recorded snapshot frozen, and stops after delivery", () => {
		const first = syncSharedSession([...history(1), { role: "user", content: "second", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, OLD);
		const path = recordSnapshot(first.sessionId, OLD);
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 3 } });

		const unchanged = syncSharedSession([...history(2), { role: "user", content: "third", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, OLD);
		assert.equal(unchanged.sessionId, first.sessionId);
		assert.equal(unchanged.appendUpdate, undefined, "nothing to deliver while the append matches the recording");

		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 5 } });
		const changed = syncSharedSession([...history(3), { role: "user", content: "fourth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, NEW);
		assert.equal(changed.sessionId, first.sessionId, "still the reuse path");
		assert.equal(changed.appendUpdate?.text, NEW);
		assert.equal(changed.appendUpdate?.digest, appendDigest(NEW));
		assert.equal(shared().lastSync.path, "reuse");
		assert.equal(shared().lastSync.appendDelivered, true);
		assert.equal(recordedAppendBlock(lastPromptSnapshot(readSessionRecords(path))), OLD, "the recorded snapshot is never rewritten on reuse");

		// The provider records the digest once the model has seen the update.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 7, deliveredAppendDigest: changed.appendUpdate.digest } });
		const again = syncSharedSession([...history(4), { role: "user", content: "fifth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, NEW);
		assert.equal(again.appendUpdate, undefined, "delivered once, not on every turn");

		// A second change is delivered again.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 9 } });
		const third = syncSharedSession([...history(5), { role: "user", content: "sixth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, `${NEW} v3`);
		assert.equal(third.appendUpdate?.text, `${NEW} v3`);
	});

	it("brings the recorded snapshot up to date only on a full rewrite, which has already lost the cache", () => {
		const first = syncSharedSession([...history(1), { role: "user", content: "second", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, OLD);
		recordSnapshot(first.sessionId, OLD);
		// Diverged history (different first prompt) means nothing can be carried.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), needsRebuild: true, forceRotate: true, rebuildReason: "abort" } });
		const rebuilt = syncSharedSession([...history(2, "a different first prompt"), { role: "user", content: "third", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, NEW);
		assert.notEqual(rebuilt.sessionId, first.sessionId);
		assert.equal(rebuilt.appendUpdate, undefined, "no in-prompt update when the snapshot itself was refreshed");
		assert.equal(shared().lastSync.covered, 0);
		const path = getSessionPath(rebuilt.sessionId, normalizeProjectPath(cwd), undefined);
		assert.equal(recordedAppendBlock(lastPromptSnapshot(readSessionRecords(path))), NEW);
	});

	it("wraps the delivered text so the model knows it supersedes the system prompt copy", () => {
		const block = formatAppendUpdate(NEW);
		assert.ok(block.startsWith("<system_prompt_update>"));
		assert.ok(block.endsWith("</system_prompt_update>"));
		assert.ok(block.includes(NEW));
	});
});

describe("project memory block forwarding", () => {
	const PROMPT = `You are a coding assistant.

The following skills provide specialized instructions for specific tasks.
<available_skills>
</available_skills>

# Project memory

You have a persistent, file-based memory at \`/vault/Memory/Agent/repo\`.

## MEMORY.md

- [A fact](a-fact.md) — hook`;

	it("extracts the block a Pi extension appended after the skills", () => {
		const block = extractMemoryBlock(PROMPT);
		assert.ok(block.startsWith("# Project memory"));
		assert.ok(block.endsWith("— hook"));
		assert.ok(!block.includes("available_skills"));
	});

	it("stops before a skills block that follows it and ignores prompts without memory", () => {
		const block = extractMemoryBlock("# Project memory\n\nindex here\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills></available_skills>");
		assert.equal(block, "# Project memory\n\nindex here");
		assert.equal(extractMemoryBlock("no memory here"), undefined);
		assert.equal(extractMemoryBlock(undefined), undefined);
	});
});

describe("AGENTS.md sanitization keeps real paths", () => {
	it("rewrites only the standalone harness name", () => {
		const input = "Pi sessions run scripts from ~/ws/pi-local/scripts and store state in ~/.pi/agent/sessions; the pi-claude and pi-codex-auth extensions and `pi update` keep working. Use pi.";
		const out = sanitizeAgentsContent(input);
		assert.ok(out.includes("~/ws/pi-local/scripts"));
		assert.ok(out.includes("~/.pi/agent/sessions"));
		assert.ok(out.includes("pi-claude"));
		assert.ok(out.includes("pi-codex-auth"));
		assert.ok(out.startsWith("environment sessions"));
		assert.ok(out.includes("`environment update`"));
		assert.ok(out.endsWith("Use environment."));
		assert.ok(!out.includes("environment-local"));
		assert.ok(!out.includes("~/.claude/agent"));
	});
});
