// AGENTS.md discovery and sanitization for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code reads the same
// content under "# CLAUDE.md". We walk up from cwd looking for AGENTS.md,
// fall back to <piUserDir>/AGENTS.md (~/.pi/agent/AGENTS.md unless
// PI_CODING_AGENT_DIR points elsewhere), and rewrite pi-specific references
// (~/.pi, .pi/, .pi, pi) to their Claude Code equivalents so any paths or
// references in the file still resolve inside the CC subprocess.
//
// In isolated mode (CLAUDE_BRIDGE_ISOLATED=1), all AGENTS.md discovery is
// disabled. Embedding hosts provide their instruction surface explicitly.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolatedFromEnv, piUserDir } from "./config.js";

function globalAgentsPath(): string {
	return join(piUserDir(), "AGENTS.md");
}

export function resolveAgentsMdPath(): string | undefined {
	if (isolatedFromEnv()) return undefined;
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	const globalPath = globalAgentsPath();
	if (existsSync(globalPath)) return globalPath;
	return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
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
