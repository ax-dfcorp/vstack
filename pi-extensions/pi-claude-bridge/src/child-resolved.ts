// Tool calls the `claude` child resolves by itself.
//
// The bridge offers Pi's tools to the child on one in-process MCP server, so a
// `tool_use` is a request for Pi to execute something only when its name is
// exactly `mcp__custom-tools__<tool>` for a tool registered on that server
// (including tools registered live, see live-tools.ts). Every other name is
// resolved by the child alone, without Pi:
// - a claude.ai connector or an MCP server Claude Code loaded itself (a project
//   `.mcp.json`, user or local settings) runs it on its own server;
// - any other name (a bare `bash`, `HymDbQuery`, a tool Pi has not activated,
//   a different casing) is rejected by Claude Code with `No such tool available`
//   before any hook or handler runs (measured 2026-11-14).
// Until 2026-11-14 such calls were also mirrored into the Pi stream. Pi ran the
// ones whose mapped name it knew (148 of 161 rejected calls in 14 days reached
// Pi, 100 ran: 59 bash commands, 24 `hym_db_query`) while the model saw only the
// rejection and usually sent the call again, so the command ran twice; for the
// rest Pi wrote a false `Tool ... not found` beside a call the child ran.
//
// Connector calls keep their own audit trail (connector-audit.ts). The others
// get one `claude-bridge-integrity` entry each, with the name and what the child
// returned, never the arguments or the payload.

import { appendIntegrityEntry } from "./bridge-state.js";
import { MCP_TOOL_PREFIX } from "./skills.js";
import type { QueryContext, ToolCallDrainCause } from "./query-state.js";

export const CHILD_RESOLVED_INTEGRITY_LABEL = "child_resolved_tool_call";

export type ChildResolvedOutcome = "ran" | "error" | "rejected" | "unobserved";

const REJECTION_MARKER = /No such tool available/;

/**
 * Whether a raw SDK tool name is a call for Pi to execute: exactly
 * `mcp__custom-tools__<name>` for a Pi tool registered on this query's server.
 * `toolNameToPi` is the query's SDK-name → Pi-name map (which also carries
 * lower-cased aliases; an alias is not an exact name and does not count).
 */
export function isPiToolCall(name: string | undefined, toolNameToPi: ReadonlyMap<string, string> | undefined): boolean {
	if (typeof name !== "string" || !toolNameToPi || !name.startsWith(MCP_TOOL_PREFIX)) return false;
	const piName = toolNameToPi.get(name);
	return piName !== undefined && `${MCP_TOOL_PREFIX}${piName}` === name;
}

/** What the child returned for a call it resolved itself. */
export function childResolvedOutcome(block: { is_error?: unknown; content?: unknown }): Exclude<ChildResolvedOutcome, "unobserved"> {
	if (block.is_error !== true) return "ran";
	let text = "";
	if (typeof block.content === "string") text = block.content;
	else if (Array.isArray(block.content)) {
		text = block.content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join(" ");
	}
	return REJECTION_MARKER.test(text) ? "rejected" : "error";
}

/** Record the child's result for one call, once. Returns whether an entry was appended. */
export function recordChildResolvedResult(
	queryCtx: QueryContext,
	toolUseId: string,
	outcome: Exclude<ChildResolvedOutcome, "unobserved">,
): boolean {
	const state = queryCtx.childResolvedCalls.get(toolUseId);
	if (!state || state.recorded) return false;
	queryCtx.childResolvedCalls.set(toolUseId, { ...state, recorded: true });
	return appendIntegrityEntry(CHILD_RESOLVED_INTEGRITY_LABEL, { name: state.name, toolUseId, outcome });
}

/** At query teardown: record every call whose result never came back. Returns the count. */
export function flushChildResolvedCalls(queryCtx: QueryContext, reason: ToolCallDrainCause): number {
	let appended = 0;
	for (const [toolUseId, state] of queryCtx.childResolvedCalls) {
		if (state.recorded) continue;
		queryCtx.childResolvedCalls.set(toolUseId, { ...state, recorded: true });
		if (appendIntegrityEntry(CHILD_RESOLVED_INTEGRITY_LABEL, { name: state.name, toolUseId, outcome: "unobserved", reason })) appended++;
	}
	return appended;
}
