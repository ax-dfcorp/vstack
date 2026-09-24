// AGENTS.md discovery and sanitization for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code reads the same
// content under "# CLAUDE.md". We forward the same context files Pi loads for
// its own system prompt (loadProjectContextFiles in pi-coding-agent): the
// global file in <piUserDir> (~/.pi/agent unless PI_CODING_AGENT_DIR points
// elsewhere) first, then one file per directory from the filesystem root down
// to cwd. Until 2026-09-24 only the nearest file was forwarded, so rules in
// ancestor and global files never reached Claude sessions inside a repo that
// had its own AGENTS.md. The harness name "pi" is rewritten so the file still
// reads correctly inside the CC subprocess.
//
// In isolated mode (CLAUDE_BRIDGE_ISOLATED=1), all AGENTS.md discovery is
// disabled. Embedding hosts provide their instruction surface explicitly.

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolatedFromEnv, piUserDir } from "./config.js";

// Same candidate names and precedence as Pi; first match per directory wins.
const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function contextFileInDir(dir: string): string | undefined {
	for (const name of CONTEXT_FILE_NAMES) {
		const candidate = join(dir, name);
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {
			// Unreadable entry: try the next candidate, as Pi does.
		}
	}
	return undefined;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function resolveAgentsMdPaths(): string[] {
	if (isolatedFromEnv()) return [];
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (path: string | undefined): boolean => {
		if (!path) return false;
		const key = canonical(path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	};

	const globalPath = contextFileInDir(piUserDir());
	if (add(globalPath)) paths.push(globalPath!);

	const ancestors: string[] = [];
	let current = resolve(process.cwd());
	while (true) {
		const found = contextFileInDir(current);
		if (add(found)) ancestors.unshift(found!);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return [...paths, ...ancestors];
}

export function extractAgentsAppend(): string | undefined {
	const blocks: string[] = [];
	for (const path of resolveAgentsMdPaths()) {
		let content: string;
		try {
			content = readFileSync(path, "utf-8").replace(/^\uFEFF/, "").trim();
		} catch {
			continue;
		}
		const sanitized = sanitizeAgentsContent(content);
		if (!sanitized) continue;
		blocks.push(`<project_instructions path="${path}">\n${sanitized}\n</project_instructions>`);
	}
	return blocks.length > 0 ? `# CLAUDE.md\n\n${blocks.join("\n\n")}` : undefined;
}

// Only the harness NAME is rewritten. Paths and identifiers that merely
// contain "pi" are real things on disk that the model's tools must reach:
// until 2026-09-22 this also turned `~/.pi/agent/sessions` into
// `~/.claude/agent/sessions` and `~/ws/pi-local` into `~/ws/environment-local`,
// so the forwarded AGENTS.md told the model to run scripts at paths that do
// not exist. The Claude Code subprocess does not act on `.pi` paths itself, so
// leaving them intact is safe.
// A sentence may end in "pi." but "pi.json" is a file name.
const STANDALONE_PI = /(?<![\w./@~-])pi(?![\w/@-]|\.\w)/gi;

export function sanitizeAgentsContent(content: string): string {
	return content.replace(STANDALONE_PI, "environment");
}
