// Changed system-prompt append, delivered as the parts that changed.
//
// The bridge's append (AGENTS.md chain, project-memory index, skills, forwarded
// Pi context) is frozen in the CLI's recorded prompt snapshot; a change on disk
// rides in the next user prompt as a <system_prompt_update> block (see
// pendingAppendUpdate in session-persistence.ts). Until 2026-11-07 that block
// always carried the whole append: a median of 142k characters on Fable, sent
// again for every change, and the HYM memory index alone changed 242 times in
// 16 days (569 Fable and 809 Opus deliveries). Each block stays in the
// conversation, so every later request of the session paid for it again.
//
// Now the block names only the parts that changed, against the text the model
// last received. The append is split into its natural parts (one per
// <project_instructions path="…">, the project-memory block, the skills block,
// the forwarded Pi context); a changed part is sent as a line diff, an added
// one in full, a removed one by name. A part whose diff would exceed 40% of
// its length is sent whole, and an update larger than half of the full text
// falls back to the full text, as before.
//
// Every block carries `version`, the first 16 hex of the sha256 of the full
// text it leaves the model with. The transcript is therefore its own record of
// what the model has seen: the last block after the last recorded snapshot
// names the version, a full block contains the text itself, and the full text
// behind a diff block is kept in a small content-addressed store. A version
// that cannot be resolved (store pruned, foreign transcript) makes the next
// update a full one.

import { createHash, randomUUID } from "crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { piUserDir } from "./config.js";
import { debug } from "./debug.js";

export const APPEND_UPDATE_TAG = "system_prompt_update";
const VERSION_HEX = 16;
/** A part whose diff is larger than this share of its own length is sent whole. */
export const SECTION_DIFF_LIMIT = 0.4;
/** An update larger than this share of the full text is sent as the full text. */
export const UPDATE_DIFF_LIMIT = 0.5;
/** Largest LCS table (lines × lines, after trimming the common prefix and suffix) a part is diffed with. */
const MAX_DIFF_CELLS = 4_000_000;
const STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function appendVersion(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, VERSION_HEX);
}

const FULL_HEADER =
	"The project instructions, project memory index, and skills appended to the system prompt have changed on disk. " +
	"The current full text follows. It replaces the copy in the system prompt and every earlier system_prompt_update.";

const DIFF_HEADER =
	"Parts of the project instructions, project memory index, or skills appended to the system prompt have changed on disk. " +
	"Below are only the changes, relative to the text as you last received it: the system prompt with every earlier system_prompt_update applied. " +
	"Apply them to that text. Every part not listed below is unchanged. " +
	"A `modified` part is a unified diff whose line numbers count from the first line of that part; `replaced` and `added` parts give the part's full new text; a `removed` part no longer exists.";

export function formatFullAppendUpdate(text: string): string {
	return [`<${APPEND_UPDATE_TAG} version="${appendVersion(text)}">`, FULL_HEADER, "", text, `</${APPEND_UPDATE_TAG}>`].join("\n");
}

// --- Parts ---

export interface AppendSection {
	key: string;
	/** The part's lines, including the blank lines that follow it, so the parts join back with "\n" into the exact text. */
	lines: string[];
}

const PROJECT_INSTRUCTIONS_OPEN = /^<project_instructions path="([^"]*)">$/;
const SKILLS_START = "The following skills provide specialized instructions";

/**
 * Split the append into its parts, or undefined when it does not split into
 * uniquely named parts that reassemble into exactly the same text.
 */
export function splitAppendSections(text: string): AppendSection[] | undefined {
	const lines = text.split("\n");
	const sections: AppendSection[] = [];
	const startsSection = (line: string): boolean =>
		PROJECT_INSTRUCTIONS_OPEN.test(line) || line === "# Project memory" || line.startsWith(SKILLS_START) || line.startsWith("<forwarded_pi_context");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		let key: string | undefined;
		let end = -1;
		const open = PROJECT_INSTRUCTIONS_OPEN.exec(line);
		if (open) {
			key = `project_instructions path="${open[1]}"`;
			end = lines.indexOf("</project_instructions>", i + 1);
		} else if (line === "# Project memory") {
			key = "project_memory";
			end = i;
			while (end + 1 < lines.length && !startsSection(lines[end + 1])) end++;
		} else if (line.startsWith(SKILLS_START)) {
			key = "skills";
			end = lines.findIndex((candidate, index) => index > i && candidate.trimEnd().endsWith("</available_skills>"));
		} else if (line.startsWith("<forwarded_pi_context")) {
			key = "forwarded_pi_context";
			end = lines.indexOf("</forwarded_pi_context>", i + 1);
		}
		if (key === undefined) {
			// Text between parts (the `# CLAUDE.md` header, separating blank lines)
			// belongs to the part before it, or to a leading preamble.
			if (sections.length === 0) sections.push({ key: "preamble", lines: [] });
			sections[sections.length - 1].lines.push(line);
			i++;
			continue;
		}
		if (end < 0) return undefined;
		if (sections.some((section) => section.key === key)) return undefined;
		sections.push({ key, lines: lines.slice(i, end + 1) });
		i = end + 1;
	}
	if (sections.map((section) => section.lines.join("\n")).join("\n") !== text) return undefined;
	return sections;
}

// --- Line diff ---

type Op = { kind: " " | "-" | "+"; line: string; oldIndex: number; newIndex: number };

/** Edit script between two line arrays (LCS), or undefined when the changed region is too large to diff. */
export function diffLines(oldLines: string[], newLines: string[]): Op[] | undefined {
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) suffix++;
	const a = oldLines.slice(prefix, oldLines.length - suffix);
	const b = newLines.slice(prefix, newLines.length - suffix);
	if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return undefined;
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let x = a.length - 1; x >= 0; x--) {
		for (let y = b.length - 1; y >= 0; y--) {
			table[x * width + y] = a[x] === b[y] ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
		}
	}
	const ops: Op[] = [];
	for (let k = 0; k < prefix; k++) ops.push({ kind: " ", line: oldLines[k], oldIndex: k, newIndex: k });
	let x = 0;
	let y = 0;
	while (x < a.length || y < b.length) {
		if (x < a.length && y < b.length && a[x] === b[y]) {
			ops.push({ kind: " ", line: a[x], oldIndex: prefix + x, newIndex: prefix + y }); x++; y++;
		} else if (x < a.length && (y === b.length || table[(x + 1) * width + y] >= table[x * width + y + 1])) {
			// Deletions before insertions at the same point, as unified diffs print them.
			ops.push({ kind: "-", line: a[x], oldIndex: prefix + x, newIndex: prefix + y }); x++;
		} else {
			ops.push({ kind: "+", line: b[y], oldIndex: prefix + x, newIndex: prefix + y }); y++;
		}
	}
	for (let k = 0; k < suffix; k++) {
		ops.push({ kind: " ", line: oldLines[oldLines.length - suffix + k], oldIndex: oldLines.length - suffix + k, newIndex: newLines.length - suffix + k });
	}
	return ops;
}

const HEADING = /^#{1,6} \S/;

/** Unified diff hunks (1 line of context) with the nearest markdown heading above each hunk, as git prints it. */
export function unifiedHunks(oldLines: string[], newLines: string[], context = 1): string | undefined {
	const ops = diffLines(oldLines, newLines);
	if (!ops) return undefined;
	const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
	if (changed.length === 0) return "";
	const hunks: Array<[number, number]> = [];
	for (const index of changed) {
		const start = Math.max(0, index - context);
		const end = Math.min(ops.length - 1, index + context);
		const last = hunks[hunks.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else hunks.push([start, end]);
	}
	const out: string[] = [];
	for (const [start, end] of hunks) {
		const slice = ops.slice(start, end + 1);
		const oldCount = slice.filter((op) => op.kind !== "+").length;
		const newCount = slice.filter((op) => op.kind !== "-").length;
		const oldStart = slice[0].oldIndex + (oldCount > 0 ? 1 : 0);
		const newStart = slice[0].newIndex + (newCount > 0 ? 1 : 0);
		let heading = "";
		for (let k = slice[0].oldIndex - 1; k >= 0; k--) {
			if (HEADING.test(oldLines[k])) { heading = ` ${oldLines[k]}`; break; }
		}
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${heading}`);
		for (const op of slice) out.push(`${op.kind}${op.line}`);
	}
	return out.join("\n");
}

/**
 * The block that brings a model from `baseline` to `current`: only the
 * changed parts when that is meaningfully smaller, otherwise the full text.
 */
export function buildAppendUpdate(baseline: string | undefined, current: string): { block: string; mode: "diff" | "full" } {
	const full = () => ({ block: formatFullAppendUpdate(current), mode: "full" as const });
	if (baseline === undefined) return full();
	const before = splitAppendSections(baseline);
	const after = splitAppendSections(current);
	if (!before || !after) return full();
	// A diff names parts but not their positions, so it can only express edits
	// inside parts that keep their order: an added, removed, or reordered part
	// (instruction precedence follows order) is sent as the full text. So is a
	// part whose name or text would collide with the <part> markup.
	const beforeKeys = before.map((section) => section.key);
	const afterKeys = after.map((section) => section.key);
	if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => key !== afterKeys[index])) return full();
	if (afterKeys.some((key) => key.includes("'"))) return full();
	const previous = new Map(before.map((section) => [section.key, section]));
	const parts: string[] = [];
	for (const section of after) {
		const old = previous.get(section.key);
		previous.delete(section.key);
		const text = section.lines.join("\n");
		if (!old) {
			parts.push(`<part name='${section.key}' change="added">\n${text}\n</part>`);
			continue;
		}
		if (old.lines.join("\n") === text) continue;
		const hunks = unifiedHunks(old.lines, section.lines);
		if (text.includes("</part>") || (hunks !== undefined && hunks.includes("</part>"))) return full();
		if (hunks === undefined || hunks.length > text.length * SECTION_DIFF_LIMIT) {
			parts.push(`<part name='${section.key}' change="replaced">\n${text}\n</part>`);
		} else {
			parts.push(`<part name='${section.key}' change="modified">\n${hunks}\n</part>`);
		}
	}
	for (const key of previous.keys()) parts.push(`<part name='${key}' change="removed"></part>`);
	if (parts.length === 0) return full();
	const body = parts.join("\n\n");
	if (body.length > current.length * UPDATE_DIFF_LIMIT) return full();
	return {
		block: [`<${APPEND_UPDATE_TAG} version="${appendVersion(current)}">`, DIFF_HEADER, "", body, `</${APPEND_UPDATE_TAG}>`].join("\n"),
		mode: "diff",
	};
}

// --- Reading what a transcript delivered ---

/** The last update block in a user record's text: its version and, for a full block, the text it carried. */
export function parseAppendUpdateBlock(text: string): { version?: string; fullText?: string } | undefined {
	const open = text.lastIndexOf(`<${APPEND_UPDATE_TAG}`);
	if (open < 0) return undefined;
	const headerEnd = text.indexOf(">", open);
	const close = text.indexOf(`\n</${APPEND_UPDATE_TAG}>`, headerEnd);
	if (headerEnd < 0 || close < 0) return undefined;
	const version = /version="([0-9a-f]+)"/.exec(text.slice(open, headerEnd))?.[1];
	const body = text.slice(headerEnd + 2, close);
	const split = body.indexOf("\n\n");
	if (split < 0) return { ...(version ? { version } : {}) };
	const header = body.slice(0, split);
	// Before 2026-11-07 every block was a full one without a version; its
	// header says the full text follows.
	if (header === FULL_HEADER || (!version && /current full text follows/.test(header))) {
		const fullText = body.slice(split + 2);
		if (version && appendVersion(fullText) !== version) return { version };
		return { ...(version ? { version } : {}), fullText };
	}
	return { ...(version ? { version } : {}) };
}

// --- Content-addressed store of delivered texts ---

export function appendBaselineDir(): string {
	return join(piUserDir(), "claude-bridge-append-versions");
}

/** Keep the full text a diff update leaves the model with, so a later process can diff against it. Atomic; prunes entries unused for 30 days. */
export function storeAppendVersion(text: string, dir = appendBaselineDir()): void {
	const version = appendVersion(text);
	const path = join(dir, `${version}.txt`);
	try {
		mkdirSync(dir, { recursive: true });
		try {
			statSync(path);
			const now = new Date();
			utimesSync(path, now, now);
			return;
		} catch { /* not stored yet */ }
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, text, "utf8");
		renameSync(temporary, path);
		const cutoff = Date.now() - STORE_MAX_AGE_MS;
		for (const name of readdirSync(dir)) {
			const entry = join(dir, name);
			try { if (statSync(entry).mtimeMs < cutoff) unlinkSync(entry); } catch { /* raced */ }
		}
	} catch (error) {
		debug("storeAppendVersion failed:", error);
	}
}

export function loadAppendVersion(version: string, dir = appendBaselineDir()): string | undefined {
	const path = join(dir, `${version}.txt`);
	try {
		const text = readFileSync(path, "utf8");
		if (appendVersion(text) !== version) return undefined;
		const now = new Date();
		try { utimesSync(path, now, now); } catch { /* read-only is fine */ }
		return text;
	} catch {
		return undefined;
	}
}
