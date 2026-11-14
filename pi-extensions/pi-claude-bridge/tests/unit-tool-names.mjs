/**
 * The names Claude calls Pi's tools by (tool-names.ts): bare (`bash`) through
 * Claude Code's CLAUDE_AGENT_SDK_MCP_NO_PREFIX, or prefixed
 * (`mcp__custom-tools__bash`). The naming is fixed per Pi session: a session
 * that already ran on the bridge keeps its names, an entry written before the
 * naming existed means prefixed, and only a session without bridge history
 * takes the configured default.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistedToolNaming, sdkToolName, sessionToolNamingFor, toolNamingEnv, SDK_MCP_NO_PREFIX_ENV } from "../src/tool-names.ts";
import { buildToolGuidanceAppend } from "../src/tool-guidance.ts";
import { extractSkillsBlock } from "../src/skills.ts";
import { readPersistedToolNaming, schedulePersistSharedSession } from "../src/session-persistence.ts";
import { setExtensionApi, setSessionToolNaming, setSharedSession } from "../src/bridge-state.ts";
import { loadConfig } from "../src/config.ts";

process.env.CLAUDE_BRIDGE_DIAG_PATH ??= `${process.cwd()}/.test-output/unit-tool-names-diag.log`;

afterEach(() => {
	setSessionToolNaming(undefined);
	setSharedSession(null);
	setExtensionApi(undefined);
});

describe("sdkToolName and the child environment", () => {
	it("names a Pi tool bare or prefixed", () => {
		assert.equal(sdkToolName("bash", "bare"), "bash");
		assert.equal(sdkToolName("bash", "prefixed"), "mcp__custom-tools__bash");
		assert.equal(sdkToolName("hym_db_query", "bare"), "hym_db_query");
	});

	it("passes the no-prefix switch only for bare names, and removes an inherited one otherwise", () => {
		assert.deepEqual(toolNamingEnv("bare"), { [SDK_MCP_NO_PREFIX_ENV]: "1" });
		const prefixed = toolNamingEnv("prefixed");
		assert.ok(SDK_MCP_NO_PREFIX_ENV in prefixed);
		assert.equal(prefixed[SDK_MCP_NO_PREFIX_ENV], undefined);
		assert.equal(SDK_MCP_NO_PREFIX_ENV, "CLAUDE_AGENT_SDK_MCP_NO_PREFIX");
	});
});

describe("the session's naming", () => {
	it("keeps a recorded naming, treats an entry without one as prefixed, and has none without an entry", () => {
		assert.equal(persistedToolNaming({ toolNaming: "bare" }), "bare");
		assert.equal(persistedToolNaming({ toolNaming: "prefixed" }), "prefixed");
		assert.equal(persistedToolNaming({}), "prefixed", "a session recorded before bare names keeps the prefix");
		assert.equal(persistedToolNaming({ toolNaming: "BARE" }), "prefixed");
		assert.equal(persistedToolNaming(undefined), undefined);
	});

	it("uses the fixed naming whatever the setting says, else the setting (default bare)", () => {
		assert.equal(sessionToolNamingFor("prefixed", true), "prefixed");
		assert.equal(sessionToolNamingFor("bare", false), "bare", "turning the setting off does not move a running session");
		assert.equal(sessionToolNamingFor(undefined, undefined), "bare");
		assert.equal(sessionToolNamingFor(undefined, true), "bare");
		assert.equal(sessionToolNamingFor(undefined, false), "prefixed");
	});

	it("is written with every bridge entry and read back from the latest one", async () => {
		const entries = [];
		const sessionManager = {
			getEntries: () => entries,
			getSessionId: () => "pi-session",
			buildSessionContext: () => ({ messages: [] }),
		};
		setExtensionApi({ appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); } });
		assert.equal(readPersistedToolNaming(sessionManager), undefined);

		setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 0, cwd: "/repo" });
		setSessionToolNaming("bare");
		schedulePersistSharedSession({ sessionManager });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.toolNaming, "bare");
		assert.equal(readPersistedToolNaming(sessionManager), "bare");

		// An entry written by an earlier bridge (no toolNaming) after it: the session keeps the prefix.
		entries.push({ type: "custom", customType: "claude-bridge-session", data: { ...entries[0].data, toolNaming: undefined } });
		assert.equal(readPersistedToolNaming(sessionManager), "prefixed");
	});
});

describe("the setting", () => {
	it("reads bareToolNames from claude-bridge.json in both shapes", async () => {
		const { writeFileSync } = await import("node:fs");
		const dir = mkdtempSync(join(tmpdir(), "claude-bridge-tool-names-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			assert.equal(loadConfig(dir).provider.bareToolNames, undefined);
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { bareToolNames: false } }));
			assert.equal(loadConfig(dir).provider.bareToolNames, false);
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ bareToolNames: false }));
			assert.equal(loadConfig(dir).provider.bareToolNames, false);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

describe("text that names the tools", () => {
	const prompt = [
		"<tools>",
		"- read: Read file contents",
		"- bash: Execute bash commands",
		"</tools>",
		"",
		"<rules>",
		"- Use read to examine files instead of cat or sed.",
		"</rules>",
	].join("\n");

	it("guidance with bare names lists the callable names and drops the mapping sentence", () => {
		const bare = buildToolGuidanceAppend(prompt, new Map([["read", "read"], ["bash", "bash"]]), "bare");
		assert.match(bare.text, /\n- read: Read file contents\n- bash: Execute bash commands\n/);
		assert.doesNotMatch(bare.text, /mcp__custom-tools__/);
		const prefixed = buildToolGuidanceAppend(prompt, new Map([["read", "mcp__custom-tools__read"], ["bash", "mcp__custom-tools__bash"]]), "prefixed");
		assert.match(prefixed.text, /tool `name` is the one you call as `mcp__custom-tools__name`/);
		assert.ok(bare.text.length < prefixed.text.length);
		assert.equal(bare.rules, prefixed.rules);
	});

	it("the skills line names the read tool only when it is prefixed", () => {
		const system = "The following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches.\n<available_skills>\n</available_skills>";
		assert.match(extractSkillsBlock(system, "bare"), /Use the read tool to load a skill's file/);
		assert.match(extractSkillsBlock(system, "prefixed"), /Use the read tool \(mcp__custom-tools__read\) to load/);
		assert.match(extractSkillsBlock(system), /mcp__custom-tools__read/);
	});
});
