// Pi's per-tool prompt guidance, forwarded to the Claude models.
//
// Pi renders two sections of its system prompt from the active tools: <tools>
// (each tool's `promptSnippet`) and <rules> (each tool's `promptGuidelines`,
// run-level guidelines, and a few built-in lines). Every other provider reads
// them; the bridge replaces Pi's system prompt with the Claude Code preset plus
// its own append, so the Claude models never saw them. Measured 2026-11-13: no
// recorded append contained rpiv-todo's guidelines, and a fresh Opus 5.5 session
// asked for nine proposals and then "do 1 and 3 first" never touched the todo
// list a GPT session kept in full.
//
// The block is taken from the text Pi rendered, so Claude gets the same words
// as GPT, with three adjustments for the Claude side:
// - tool names in the list are the names Claude calls (`mcp__custom-tools__…`);
//   rules keep Pi's bare names, mapped once by the block's first line;
// - a tool Claude cannot call (not offered over MCP, e.g. a child-native
//   connector) is left out of the list, and so is every rule that names it;
// - Pi's two built-in style lines are left out: they are not tool guidance, and
//   the Claude Code preset sets its own response style.
// It is one named part of the append, so a change to the active tools reaches a
// running session as a diff of this part (append-update.ts), never a rebuild.

import { MCP_SERVER_NAME } from "./skills.js";

export const TOOL_GUIDANCE_TAG = "pi_tool_guidance";

/** Pi's built-in closing rules (system-prompt.js buildRules): response style, not tool guidance. */
export const DROPPED_BUILTIN_RULES = new Set([
	"Be concise in your responses",
	"Show file paths clearly when working with files",
]);

const TOOL_LINE = /^- ([^:\s]+): (.*)$/;

export interface ToolGuidance {
	text?: string;
	/** Tools in Pi's list that Claude cannot call, left out. */
	droppedTools: string[];
	/** Rules left out: the built-in style lines and rules naming a tool Claude cannot call. */
	droppedRules: string[];
	/** Tools whose snippet is forwarded, in Pi's order. */
	tools: string[];
	rules: number;
}

/** The body of one `<name>` section of Pi's rendered system prompt. */
export function extractPromptSection(systemPrompt: string | undefined, name: string): string | undefined {
	if (!systemPrompt) return undefined;
	const open = `<${name}>\n`;
	const close = `\n</${name}>`;
	let start = -1;
	// Only a section that starts a line (Pi renders each as its own block).
	for (let index = systemPrompt.indexOf(open); index >= 0; index = systemPrompt.indexOf(open, index + 1)) {
		if (index === 0 || systemPrompt[index - 1] === "\n") {
			start = index;
			break;
		}
	}
	if (start < 0) return undefined;
	const end = systemPrompt.indexOf(close, start + open.length);
	if (end < 0) return undefined;
	return systemPrompt.slice(start + open.length, end);
}

function mentionsTool(rule: string, tool: string): boolean {
	const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(rule);
}

/**
 * Build the `<pi_tool_guidance>` append part from Pi's rendered system prompt.
 * `toolNameToSdk` maps each Pi tool Claude can call to the name Claude calls it by.
 */
export function buildToolGuidanceAppend(systemPrompt: string | undefined, toolNameToSdk: ReadonlyMap<string, string>): ToolGuidance {
	const result: ToolGuidance = { droppedTools: [], droppedRules: [], tools: [], rules: 0 };
	const toolsSection = extractPromptSection(systemPrompt, "tools");
	const rulesSection = extractPromptSection(systemPrompt, "rules");
	if (toolsSection === undefined && rulesSection === undefined) return result;

	const toolLines: string[] = [];
	for (const line of (toolsSection ?? "").split("\n")) {
		const match = TOOL_LINE.exec(line);
		if (!match) {
			// "(none)", "Additional tools may be available.", blank lines: Pi's own wording, kept.
			toolLines.push(line);
			continue;
		}
		const [, name, snippet] = match;
		const sdkName = toolNameToSdk.get(name);
		if (!sdkName) {
			result.droppedTools.push(name);
			continue;
		}
		result.tools.push(name);
		toolLines.push(`- ${sdkName}: ${snippet}`);
	}

	const ruleLines: string[] = [];
	for (const line of (rulesSection ?? "").split("\n")) {
		if (!line.startsWith("- ")) {
			if (line.trim()) ruleLines.push(line);
			continue;
		}
		const rule = line.slice(2);
		if (DROPPED_BUILTIN_RULES.has(rule) || result.droppedTools.some((tool) => mentionsTool(rule, tool))) {
			result.droppedRules.push(rule);
			continue;
		}
		ruleLines.push(line);
	}
	result.rules = ruleLines.filter((line) => line.startsWith("- ")).length;

	const tools = toolLines.join("\n").trim();
	const rules = ruleLines.join("\n").trim();
	if (!tools && !rules) return result;
	const parts = [
		`<${TOOL_GUIDANCE_TAG}>`,
		`Pi's notes and rules for the tools in this session, the same ones Pi gives every other model. The rules use Pi's tool names: tool \`name\` is the one you call as \`mcp__${MCP_SERVER_NAME}__name\`.`,
	];
	if (tools) parts.push("", "Tools:", tools);
	if (rules) parts.push("", "Rules:", rules);
	parts.push(`</${TOOL_GUIDANCE_TAG}>`);
	result.text = parts.join("\n");
	return result;
}
