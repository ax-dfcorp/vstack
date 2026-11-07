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
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { sanitizeAgentsContent } from "../src/agents-md.ts";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { appendVersion, formatFullAppendUpdate, parseAppendUpdateBlock, splitAppendSections, unifiedHunks } from "../src/append-update.ts";
import { getSessionPath, normalizeProjectPath } from "cc-session-io";

import { __testResetAppendDeliveries, appendPromptSnapshotRecord, confirmAppendUpdate, lastPromptSnapshot, readSessionRecords, recordedAppendBlock, syncSharedSession } from "../src/session-persistence.ts";
import { extractMemoryBlock } from "../src/skills.ts";

const root = mkdtempSync(join(tmpdir(), "claude-append-update-"));
const cwd = join(root, "project");
// The content store of delivered versions lives in the Pi agent dir.
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

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
		assert.equal(changed.appendUpdate?.version, appendVersion(NEW));
		assert.ok(changed.appendUpdate?.block.includes("new instructions"));
		assert.equal(shared().lastSync.path, "reuse");
		assert.equal(shared().lastSync.appendDelivered, true);
		assert.equal(recordedAppendBlock(lastPromptSnapshot(readSessionRecords(path))), OLD, "the recorded snapshot is never rewritten on reuse");

		// The provider confirms delivery once the query completed.
		confirmAppendUpdate(changed.appendUpdate);
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 7 } });
		const again = syncSharedSession([...history(4), { role: "user", content: "fifth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, NEW);
		assert.equal(again.appendUpdate, undefined, "delivered once, not on every turn");

		// A second change is delivered again.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 9 } });
		const third = syncSharedSession([...history(5), { role: "user", content: "sixth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, `${NEW} v3`);
		assert.equal(third.appendUpdate?.version, appendVersion(`${NEW} v3`));
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

		// The refreshed snapshot is the new baseline: unchanged text sends nothing, a change diffs against NEW.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 5 } });
		const next = syncSharedSession([...history(2, "a different first prompt"), { role: "user", content: "third", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now() }, { role: "user", content: "fourth", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, NEW);
		assert.equal(next.appendUpdate, undefined);
	});

	it("wraps a full update so the model knows it replaces the system prompt copy and every earlier update", () => {
		const block = formatFullAppendUpdate(NEW);
		assert.ok(block.startsWith(`<system_prompt_update version="${appendVersion(NEW)}">`));
		assert.ok(block.endsWith("</system_prompt_update>"));
		assert.ok(block.includes(NEW));
		assert.ok(block.includes("every earlier system_prompt_update"));
		assert.deepEqual(parseAppendUpdateBlock(`${block}\n\nthe prompt`), { version: appendVersion(NEW), fullText: NEW });
	});
});

// A realistic append: two AGENTS files, the memory index, and skills.
function realisticAppend({ memoryLines = 60, extraMemory = [], dropMemory = -1, homeRule = "Answer in Korean." } = {}) {
	const index = [];
	for (let i = 0; i < memoryLines; i++) if (i !== dropMemory) index.push(`- [Fact ${i}](fact-${i}.md) — hook number ${i} with a reasonably long description of the state`);
	index.push(...extraMemory);
	const agents = (name, rule) => [`<project_instructions path="/repo/${name}/AGENTS.md">`, `# ${name}`, "", "## Rules", "", ...Array.from({ length: 80 }, (_, i) => `- ${name} rule ${i}: keep this exact wording of instruction number ${i}.`), `- ${rule}`, "</project_instructions>"].join("\n");
	return [
		["# CLAUDE.md", "", agents("home", homeRule), "", agents("repo", "Run the tests.")].join("\n"),
		["# Project memory", "", "You have a persistent memory.", "", "## MEMORY.md", "", "## Section one", ...index].join("\n"),
		["The following skills provide specialized instructions for specific tasks.", "<available_skills>", ...Array.from({ length: 30 }, (_, i) => `  <skill><name>s${i}</name><description>Skill ${i} does a thing.</description></skill>`), "</available_skills>"].join("\n"),
	].join("\n\n");
}

/** Write what the CLI would record for a turn whose prompt carried `block`. */
function recordDeliveredPrompt(path, sessionId, block) {
	const records = readSessionRecords(path);
	let parentUuid = null;
	for (let i = records.length - 1; i >= 0; i--) if (records[i].uuid) { parentUuid = records[i].uuid; break; }
	const uuid = `u-${Math.random().toString(16).slice(2)}`;
	appendFileSync(path, `${JSON.stringify({ type: "user", uuid, parentUuid, sessionId, message: { role: "user", content: [{ type: "text", text: block }, { type: "text", text: "the prompt" }] } })}\n`);
}

describe("only the changed parts are delivered", () => {
	const BASE = realisticAppend();
	let turn = 0;
	function setup(appendAtStart = BASE) {
		__testResetAppendDeliveries();
		turn = 0;
		const first = syncSharedSession([...history(1), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, appendAtStart);
		const path = recordSnapshot(first.sessionId, appendAtStart);
		return { sessionId: first.sessionId, path };
	}
	function sync(append) {
		turn++;
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 1 + 2 * turn } });
		return syncSharedSession([...history(turn + 1), { role: "user", content: "next", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, append);
	}

	it("sends one added memory line as a diff under 2k characters", () => {
		setup();
		const next = realisticAppend({ extraMemory: ["- [New fact](new-fact.md) — just learned"] });
		const result = sync(next);
		assert.equal(result.appendUpdate.mode, "diff");
		assert.ok(result.appendUpdate.block.length < 2000, `block is ${result.appendUpdate.block.length} chars`);
		assert.ok(BASE.length > 15_000, `the full append is large (${BASE.length} chars)`);
		assert.ok(result.appendUpdate.block.includes("<part name='project_memory' change=\"modified\">"));
		assert.ok(result.appendUpdate.block.includes("+- [New fact](new-fact.md) — just learned"));
		assert.ok(result.appendUpdate.block.includes("@@ -"));
		assert.ok(result.appendUpdate.block.includes("## Section one"), "the hunk names the nearest heading");
		assert.ok(result.appendUpdate.block.includes("Every part not listed below is unchanged"));
		assert.ok(!result.appendUpdate.block.includes("rule 40"), "unchanged parts are not repeated");
	});

	it("sends one removed line as a deletion", () => {
		setup();
		const result = sync(realisticAppend({ dropMemory: 30 }));
		assert.equal(result.appendUpdate.mode, "diff");
		assert.ok(result.appendUpdate.block.includes("-- [Fact 30](fact-30.md)"));
		assert.ok(result.appendUpdate.block.length < 2000);
	});

	it("A → B → A sends the reversal, because the model holds B", () => {
		setup();
		const B = realisticAppend({ homeRule: "Answer in English." });
		const toB = sync(B);
		assert.ok(toB.appendUpdate.block.includes("+- Answer in English."));
		confirmAppendUpdate(toB.appendUpdate);
		const backToA = sync(BASE);
		assert.ok(backToA.appendUpdate, "reverting to the snapshot text is a change for a model that holds B");
		assert.ok(backToA.appendUpdate.block.includes("-- Answer in English."));
		assert.ok(backToA.appendUpdate.block.includes("+- Answer in Korean."));
		assert.ok(backToA.appendUpdate.block.indexOf("-- Answer in English.") < backToA.appendUpdate.block.indexOf("+- Answer in Korean."), "deletions print before insertions");
		assert.equal(backToA.appendUpdate.version, appendVersion(BASE));
	});

	it("an unconfirmed update is re-read from the transcript, whichever way the attempt ended", () => {
		const { path, sessionId } = setup();
		const B = realisticAppend({ homeRule: "Answer in English." });
		const failed = sync(B);
		// The attempt failed before the CLI wrote the prompt: the model still holds A.
		const retry = sync(B);
		assert.ok(retry.appendUpdate.block.includes("-- Answer in Korean."), "diffed against A again");
		// This attempt reached the CLI (it recorded the prompt) but the provider never confirmed it.
		recordDeliveredPrompt(path, sessionId, retry.appendUpdate.block);
		const after = sync(B);
		assert.equal(after.appendUpdate, undefined, "the transcript shows the model already holds B");
		assert.equal(failed.appendUpdate.version, retry.appendUpdate.version);
	});

	it("a restarted process diffs against the version the transcript names", () => {
		const { path, sessionId } = setup();
		const B = realisticAppend({ extraMemory: ["- [B fact](b.md) — b"] });
		const toB = sync(B);
		recordDeliveredPrompt(path, sessionId, toB.appendUpdate.block);
		confirmAppendUpdate(toB.appendUpdate);
		__testResetAppendDeliveries();
		const C = realisticAppend({ extraMemory: ["- [B fact](b.md) — b", "- [C fact](c.md) — c"] });
		const toC = sync(C);
		assert.equal(toC.appendUpdate.mode, "diff");
		assert.ok(toC.appendUpdate.block.includes("+- [C fact](c.md) — c"));
		assert.ok(!toC.appendUpdate.block.includes("+- [B fact](b.md) — b"), "B is already known from the transcript");
	});

	it("a version whose text is no longer stored makes the next update a full one", () => {
		const { path, sessionId } = setup();
		const B = realisticAppend({ extraMemory: ["- [B fact](b.md) — b"] });
		const toB = sync(B);
		recordDeliveredPrompt(path, sessionId, toB.appendUpdate.block);
		rmSync(join(agentDir, "claude-bridge-append-versions", `${toB.appendUpdate.version}.txt`));
		__testResetAppendDeliveries();
		const toC = sync(realisticAppend({ extraMemory: ["- [C fact](c.md) — c"] }));
		assert.equal(toC.appendUpdate.mode, "full");
		// Unchanged from the unresolvable version: still nothing to send.
		__testResetAppendDeliveries();
		recordDeliveredPrompt(path, sessionId, formatFullAppendUpdate(B));
		assert.equal(sync(B).appendUpdate, undefined);
	});

	it("reads the full text of a block written before versions existed", () => {
		const { path, sessionId } = setup();
		const B = realisticAppend({ homeRule: "Legacy rule." });
		const legacy = ["<system_prompt_update>", "The project instructions, project memory index, and skills that were appended to the system prompt when this conversation started have changed on disk. The current full text follows and supersedes the earlier copy in the system prompt.", "", B, "</system_prompt_update>"].join("\n");
		recordDeliveredPrompt(path, sessionId, legacy);
		__testResetAppendDeliveries();
		assert.equal(sync(B).appendUpdate, undefined, "the legacy block's text is what the model holds");
		const C = realisticAppend({ homeRule: "Newer rule." });
		const toC = sync(C);
		assert.equal(toC.appendUpdate.mode, "diff");
		assert.ok(toC.appendUpdate.block.includes("-- Legacy rule."));
	});

	it("sends a large change, an added part, and a removed part correctly", () => {
		setup();
		// Most of the memory index rewritten: full text.
		const rewritten = realisticAppend({ memoryLines: 0, extraMemory: Array.from({ length: 300 }, (_, i) => `- [Other ${i}](o-${i}.md) — rewritten line ${i} with a long description of different content`) });
		assert.equal(sync(rewritten).appendUpdate.mode, "full");
		setup();
		const withContext = `${BASE}\n\n<forwarded_pi_context>\nextra hook text\n</forwarded_pi_context>`;
		const added = sync(withContext);
		assert.ok(added.appendUpdate.block.includes("<part name='forwarded_pi_context' change=\"added\">\n<forwarded_pi_context>\nextra hook text"));
		confirmAppendUpdate(added.appendUpdate);
		const withoutRepo = withContext.replace(/\n\n<project_instructions path="\/repo\/repo\/AGENTS.md">[\s\S]*?<\/project_instructions>/, "");
		const removed = sync(withoutRepo);
		assert.equal(removed.appendUpdate.mode, "diff");
		assert.ok(removed.appendUpdate.block.includes(`<part name='project_instructions path="/repo/repo/AGENTS.md"' change="removed"></part>`));
	});

	it("an empty append sends nothing", () => {
		setup();
		assert.equal(sync(undefined).appendUpdate, undefined);
		assert.equal(sync("").appendUpdate, undefined);
	});
});

/** Apply unified hunks as a reader would: by the old line numbers in each @@ header. */
function applyHunks(oldLines, hunks) {
	const out = [];
	let cursor = 0;
	const lines = hunks.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@/.exec(lines[i]);
		assert.ok(header, `hunk header expected, got ${lines[i]}`);
		const oldStart = Number(header[1]) - (Number(header[2]) > 0 ? 1 : 0);
		while (cursor < oldStart) out.push(oldLines[cursor++]);
		while (i + 1 < lines.length && !lines[i + 1].startsWith("@@ ")) {
			const line = lines[++i];
			if (line[0] === " ") { assert.equal(oldLines[cursor], line.slice(1)); out.push(oldLines[cursor++]); }
			else if (line[0] === "-") { assert.equal(oldLines[cursor], line.slice(1)); cursor++; }
			else out.push(line.slice(1));
		}
	}
	while (cursor < oldLines.length) out.push(oldLines[cursor++]);
	return out;
}

describe("unifiedHunks", () => {
	it("round-trips random edits", () => {
		let seed = 7;
		const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
		for (let round = 0; round < 200; round++) {
			const before = Array.from({ length: 5 + random(60) }, (_, i) => (random(4) === 0 ? "" : `line ${i % 9}`));
			const after = [...before];
			for (let edit = 0; edit < 1 + random(6); edit++) {
				const at = random(after.length + 1);
				const kind = random(3);
				if (kind === 0) after.splice(at, 0, `inserted ${round}.${edit}`);
				else if (kind === 1 && after.length > 0) after.splice(Math.min(at, after.length - 1), 1);
				else if (after.length > 0) after[Math.min(at, after.length - 1)] = `changed ${round}.${edit}`;
			}
			const hunks = unifiedHunks(before, after);
			if (hunks === "") { assert.deepEqual(after, before); continue; }
			assert.deepEqual(applyHunks(before, hunks), after, `round ${round}`);
		}
	});
});

describe("splitAppendSections", () => {
	it("splits into named parts that join back into the exact text", () => {
		const text = realisticAppend();
		const sections = splitAppendSections(text);
		assert.deepEqual(sections.map((section) => section.key), ["preamble", 'project_instructions path="/repo/home/AGENTS.md"', 'project_instructions path="/repo/repo/AGENTS.md"', "project_memory", "skills"]);
		assert.equal(sections.map((section) => section.lines.join("\n")).join("\n"), text);
	});
	it("refuses duplicate or unterminated parts", () => {
		const one = `<project_instructions path="/a">\nx\n</project_instructions>`;
		assert.equal(splitAppendSections(`${one}\n\n${one}`), undefined);
		assert.equal(splitAppendSections(`<project_instructions path="/a">\nnever closed`), undefined);
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
