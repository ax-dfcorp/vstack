// The names Claude calls Pi's tools by.
//
// The bridge offers Pi's tools to the `claude` child on one in-process (SDK)
// MCP server. By default Claude Code names such a tool `mcp__<server>__<tool>`,
// so Pi's `bash` was offered as `mcp__custom-tools__bash`, while Pi, its tool
// guidance, skills, and briefings all call it `bash`. Claude models called the
// bare name anyway (73 `No such tool available` rejections in 14 days, about 2%
// of sessions, 30 of them the session's first call), and no hook or handler can
// see a rejected name (measured 2026-11-14).
//
// Claude Code has a supported switch for exactly this:
// `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1` in the child's environment makes tools
// from SDK-created MCP servers keep their original names
// (https://code.claude.com/docs/en/env-vars). It applies to `type: "sdk"`
// servers only; claude.ai connectors and servers from `.mcp.json` or settings
// keep their `mcp__<server>__` names.
//
// `bare` is that mode; `prefixed` is the earlier one.

import { MCP_TOOL_PREFIX } from "./skills.js";

export type ToolNaming = "bare" | "prefixed";

/** The Claude Code environment variable that turns off the SDK server prefix. */
export const SDK_MCP_NO_PREFIX_ENV = "CLAUDE_AGENT_SDK_MCP_NO_PREFIX";

/** The name Claude calls Pi tool `piName` by. */
export function sdkToolName(piName: string, naming: ToolNaming): string {
	return naming === "bare" ? piName : `${MCP_TOOL_PREFIX}${piName}`;
}

/** Child-environment entries for `naming`; the prefixed mode removes an inherited switch. */
export function toolNamingEnv(naming: ToolNaming): Record<string, string | undefined> {
	return { [SDK_MCP_NO_PREFIX_ENV]: naming === "bare" ? "1" : undefined };
}

// The naming is fixed per Pi session. Changing it in a session that already ran
// on the bridge makes Claude Code announce every tool again under its new name
// and re-send the tool guidance: measured 2026-11-14, the session's next request
// grew from 68k to 121k tokens and wrote the difference to the cache. So a
// session keeps the naming its first bridge query used (recorded with the
// session's `claude-bridge-session` entries, so it survives restarts, resumes,
// and account hand-offs); a session recorded before the naming existed keeps the
// prefixed names; only a session with no bridge history takes the configured
// default (`provider.bareToolNames`, on unless set to false).

/** The naming recorded in a session's latest bridge entry; prefixed for an entry written before bare names existed; undefined without an entry. */
export function persistedToolNaming(entry: { toolNaming?: unknown } | undefined): ToolNaming | undefined {
	if (!entry) return undefined;
	return entry.toolNaming === "bare" || entry.toolNaming === "prefixed" ? entry.toolNaming : "prefixed";
}

/** The naming a query uses: the session's fixed one, else the configured default. */
export function sessionToolNamingFor(fixed: ToolNaming | undefined, bareToolNames: boolean | undefined): ToolNaming {
	return fixed ?? (bareToolNames === false ? "prefixed" : "bare");
}
