/**
 * Pi's per-tool prompt guidance reaches the Claude models (tool-guidance.ts):
 * the <tools> and <rules> sections Pi renders for every other model, with the
 * names Claude calls, without tools Claude cannot call, and as its own append
 * part so a change to the active tools travels as a diff of that part.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAppendUpdate, splitAppendSections } from "../src/append-update.ts";
import { buildToolGuidanceAppend, extractPromptSection } from "../src/tool-guidance.ts";

// Pi's own renderer, so the test follows the format Pi actually sends.
const { buildSystemPrompt } = await import(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href
);

const TODO_RULE = "When a reply proposes three or more items for the user, put every item on the `todo` list in one batch.";
const CONNECTOR_RULE = "Use gmail_connector_search before asking where a mail is.";

function piPrompt({ extraTools = [] } = {}) {
	return buildSystemPrompt({
		cwd: "/repo",
		selectedTools: ["read", "bash", "todo", "gmail_connector_search", ...extraTools],
		toolSnippets: {
			read: "Read file contents",
			bash: "Execute bash commands (ls, grep, find, etc.)",
			todo: "The session's task list, shown to the user as the progress board above the composer",
			gmail_connector_search: "Search Gmail through the account connector",
			...Object.fromEntries(extraTools.map((name) => [name, `Snippet of ${name}`])),
		},
		toolGuidelines: {
			read: ["Use read to examine files instead of cat or sed."],
			todo: [TODO_RULE],
			gmail_connector_search: [CONNECTOR_RULE],
		},
		// A project file that quotes a section tag on its own line must not be taken for the section.
		contextFiles: [{ path: "/repo/AGENTS.md", content: "Notes\n<tools>\n- fake: not a tool\n</tools>" }],
	});
}

const callable = new Map([
	["read", "mcp__custom-tools__read"],
	["bash", "mcp__custom-tools__bash"],
	["todo", "mcp__custom-tools__todo"],
	["late_tool", "mcp__custom-tools__late_tool"],
]);

describe("Pi tool guidance for Claude", () => {
	it("takes Pi's rendered <tools> and <rules>, not a project file quoting the tag", () => {
		const prompt = piPrompt();
		assert.match(extractPromptSection(prompt, "tools"), /^- read: Read file contents/);
		assert.doesNotMatch(extractPromptSection(prompt, "tools"), /fake/);
	});

	it("names tools as Claude calls them and keeps Pi's rules word for word", () => {
		const guidance = buildToolGuidanceAppend(piPrompt(), callable);
		assert.deepEqual(guidance.tools, ["read", "bash", "todo"]);
		assert.ok(guidance.text.startsWith("<pi_tool_guidance>\n"));
		assert.ok(guidance.text.endsWith("\n</pi_tool_guidance>"));
		assert.match(guidance.text, /\n- mcp__custom-tools__todo: The session's task list, shown to the user as the progress board above the composer\n/);
		assert.match(guidance.text, /tool `name` is the one you call as `mcp__custom-tools__name`/);
		assert.ok(guidance.text.includes(`\n- ${TODO_RULE}`));
		assert.ok(guidance.text.includes("\n- Use read to examine files instead of cat or sed."));
		assert.ok(guidance.text.includes("\nAdditional tools may be available."));
	});

	it("leaves out tools Claude cannot call, the rules that name them, and Pi's style lines", () => {
		const guidance = buildToolGuidanceAppend(piPrompt(), callable);
		assert.deepEqual(guidance.droppedTools, ["gmail_connector_search"]);
		assert.deepEqual(guidance.droppedRules, [CONNECTOR_RULE, "Be concise in your responses", "Show file paths clearly when working with files"]);
		assert.doesNotMatch(guidance.text, /gmail_connector_search|Be concise|Show file paths/);
	});

	it("forwards nothing when Pi rendered no tool sections (a custom system prompt)", () => {
		const guidance = buildToolGuidanceAppend(buildSystemPrompt({ cwd: "/repo", customPrompt: "Custom." }), callable);
		assert.equal(guidance.text, undefined);
	});

	it("is its own append part, and a tool added mid-session travels as a diff of that part only", () => {
		const head = '# CLAUDE.md\n\n<project_instructions path="/repo/AGENTS.md">\n' + Array.from({ length: 30 }, (_, i) => `rule ${i}`).join("\n") + "\n</project_instructions>";
		const before = `${head}\n\n${buildToolGuidanceAppend(piPrompt(), callable).text}`;
		const after = `${head}\n\n${buildToolGuidanceAppend(piPrompt({ extraTools: ["late_tool"] }), callable).text}`;
		assert.deepEqual(splitAppendSections(after).map((section) => section.key), ["preamble", 'project_instructions path="/repo/AGENTS.md"', "pi_tool_guidance"]);
		const update = buildAppendUpdate(before, after);
		assert.equal(update.mode, "diff");
		assert.match(update.block, /<part name='pi_tool_guidance' change="modified">\n@@[^\n]*\n[^]*\+- mcp__custom-tools__late_tool: Snippet of late_tool/);
		assert.doesNotMatch(update.block, /project_instructions/);
	});

	it("reaches a session recorded before it existed as one added part, not the whole append", () => {
		const head = '# CLAUDE.md\n\n<project_instructions path="/repo/AGENTS.md">\n' + Array.from({ length: 200 }, (_, i) => `rule ${i}: a long enough instruction to dwarf the added part`).join("\n") + "\n</project_instructions>";
		const guidance = buildToolGuidanceAppend(piPrompt(), callable).text;
		const update = buildAppendUpdate(head, `${head}\n\n${guidance}`);
		assert.equal(update.mode, "diff");
		assert.ok(update.block.includes(`<part name='pi_tool_guidance' change="added">\n${guidance}\n</part>`));
		// The separating blank line is not reported as a change to the part before.
		assert.equal((update.block.match(/<part name=/g) ?? []).length, 1);
		assert.ok(update.block.length < head.length / 2);
		// A part added anywhere but after every other part still sends the full text.
		assert.equal(buildAppendUpdate(head, `${guidance}\n\n${head}`).mode, "full");
	});
});
