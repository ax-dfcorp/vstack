/**
 * The forwarded AGENTS.md chain mirrors Pi's loadProjectContextFiles: the
 * global <piUserDir> file first, then one file per directory from the
 * filesystem root down to cwd, deduped by realpath. Until 2026-09-24 only the
 * nearest file was forwarded, so ancestor rules (e.g. ~/AGENTS.md) never
 * reached Claude sessions inside a repo with its own AGENTS.md.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgentsAppend, resolveAgentsMdPaths } from "../src/agents-md.ts";

const ENV_KEYS = ["CLAUDE_BRIDGE_ISOLATED", "PI_CODING_AGENT_DIR"];

// <root>/home/.pi/agent (agent dir), <root>/home (~/AGENTS.md), <root>/home/ws/hym (repo).
function withTree(fn, { isolated } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-bridge-agents-md-")));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const repo = join(home, "ws", "hym");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(repo, { recursive: true });
	const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	const oldCwd = process.cwd();
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		if (isolated) process.env.CLAUDE_BRIDGE_ISOLATED = "1";
		else delete process.env.CLAUDE_BRIDGE_ISOLATED;
		process.chdir(repo);
		return fn({ root, home, agentDir, repo });
	} finally {
		process.chdir(oldCwd);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

function blockPaths(append) {
	return [...append.matchAll(/<project_instructions path="([^"]+)">/g)].map((match) => match[1]);
}

describe("resolveAgentsMdPaths", () => {
	it("forwards global, then ancestors root to cwd, as three blocks under # CLAUDE.md", () => withTree(({ home, agentDir, repo }) => {
		writeFileSync(join(agentDir, "AGENTS.md"), "global rules\n");
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules\n");
		const expected = [join(agentDir, "AGENTS.md"), join(home, "AGENTS.md"), join(repo, "AGENTS.md")];
		assert.deepEqual(resolveAgentsMdPaths(), expected);

		const append = extractAgentsAppend() ?? "";
		assert.ok(append.startsWith("# CLAUDE.md\n\n"), append.slice(0, 40));
		assert.deepEqual(blockPaths(append), expected);
		assert.ok(append.indexOf("global rules") < append.indexOf("home rules"));
		assert.ok(append.indexOf("home rules") < append.indexOf("repo rules"));
		assert.match(append, /<project_instructions path="[^"]+">\nrepo rules\n<\/project_instructions>$/);
	}));

	it("a repo without its own AGENTS.md still gets global and the home file", () => withTree(({ home, agentDir }) => {
		writeFileSync(join(agentDir, "AGENTS.md"), "global rules\n");
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		assert.deepEqual(resolveAgentsMdPaths(), [join(agentDir, "AGENTS.md"), join(home, "AGENTS.md")]);
	}));

	it("uses Pi's candidate precedence, one file per directory", () => withTree(({ home, repo }) => {
		writeFileSync(join(home, "CLAUDE.md"), "claude-named rules\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules\n");
		writeFileSync(join(repo, "AGENTS.override.md"), "override rules\n");
		assert.deepEqual(resolveAgentsMdPaths(), [join(home, "CLAUDE.md"), join(repo, "AGENTS.override.md")]);
	}));

	it("dedupes by realpath when the global file is also an ancestor", () => withTree(({ root, home, repo }) => {
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules\n");
		// Agent dir is a symlink to the home dir, so its AGENTS.md is ~/AGENTS.md.
		const linkedAgentDir = join(root, "linked-agent");
		symlinkSync(home, linkedAgentDir);
		process.env.PI_CODING_AGENT_DIR = linkedAgentDir;
		const paths = resolveAgentsMdPaths();
		assert.deepEqual(paths, [join(linkedAgentDir, "AGENTS.md"), join(repo, "AGENTS.md")]);
		assert.equal((extractAgentsAppend() ?? "").match(/home rules/g)?.length, 1);
	}));

	it("does not repeat the global file when cwd is the agent dir", () => withTree(({ home, agentDir }) => {
		writeFileSync(join(agentDir, "AGENTS.md"), "global rules\n");
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		process.chdir(agentDir);
		assert.deepEqual(resolveAgentsMdPaths(), [join(agentDir, "AGENTS.md"), join(home, "AGENTS.md")]);
	}));

	it("skips empty files without dropping the rest", () => withTree(({ home, agentDir, repo }) => {
		writeFileSync(join(agentDir, "AGENTS.md"), "   \n");
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules\n");
		assert.deepEqual(blockPaths(extractAgentsAppend() ?? ""), [join(home, "AGENTS.md"), join(repo, "AGENTS.md")]);
	}));

	it("isolated mode forwards nothing", () => withTree(({ home, agentDir, repo }) => {
		writeFileSync(join(agentDir, "AGENTS.md"), "global rules\n");
		writeFileSync(join(home, "AGENTS.md"), "home rules\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules\n");
		assert.deepEqual(resolveAgentsMdPaths(), []);
		assert.equal(extractAgentsAppend(), undefined);
	}, { isolated: true }));
});
