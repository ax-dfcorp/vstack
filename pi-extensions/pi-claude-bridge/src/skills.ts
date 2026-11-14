// Skills block extraction + MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Extract skills block from pi's system prompt for forwarding to Claude Code.
// `naming` is the name the read tool is offered under (tool-names.ts): with bare
// names Pi's own sentence already names the callable tool and is kept as is.
export function extractSkillsBlock(systemPrompt?: string, naming: "bare" | "prefixed" = "prefixed"): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	const block = systemPrompt.slice(start, end + endMarker.length).trim();
	return naming === "bare" ? block : rewriteSkillsBlock(block);
}

// Extract the shared project-memory block that a Pi extension appends to the
// system prompt ("# Project memory" … the MEMORY.md index and write policy).
// Everything else in Pi's system prompt is replaced by the Claude Code preset,
// so without this the Claude models were the only ones that never saw the
// memory every other provider reads and writes (verified 2026-09-22 against
// recorded prompt snapshots: AGENTS.md and skills present, memory absent).
export function extractMemoryBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "# Project memory\n";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const skillsStart = systemPrompt.indexOf("The following skills provide specialized instructions", start);
	const block = systemPrompt.slice(start, skillsStart === -1 ? undefined : skillsStart).trim();
	return block.length > startMarker.length ? block : undefined;
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}
