// Tools Pi activates in the middle of a query.
//
// A loader tool (pi-local's `hym_ops_tools`) calls `pi.setActiveTools` from its
// execute(); Pi hands the larger tool set to the provider with that call's
// result. The child's MCP server was built from the tool set at query start, so
// a call to the new tool in the same turn got Claude Code's
// `No such tool available` and only the next turn could use it (reproduced
// 2026-11-14). The provider now registers such tools on the query's live
// in-process server; the MCP SDK sends `notifications/tools/list_changed`, and
// Claude Code refetches the list and announces the new tool to the model as a
// deferred-tools delta after the conversation, so the cached prefix is kept.
//
// The refetch runs while the loader's MCP call is still open. If the loader's
// result reached the child first, the next model request was built before the
// refetch finished: the call still dispatched (the lookup happens later) but
// the model had not been told the new tool's name or schema and had to guess
// it (one of ten measured runs guessed the bare name and was rejected). So the
// results of that delivery are released only once the child's own view of the
// server lists the new tools (`Query.mcpServerStatus()`), measured at 22-25 ms.
// The wait is bounded; a child that cannot report its tool list ends it at once.

export interface ChildServerStatus {
	name: string;
	tools?: Array<{ name: string }>;
}

export interface ChildToolLister {
	mcpServerStatus(): Promise<ChildServerStatus[]>;
}

export interface ChildToolListOutcome {
	/** "listed": the child lists every tool. "unsupported": it reports no tool list
	 *  for the server. "timeout": not listed within the bound. "error": the status
	 *  request failed. */
	outcome: "listed" | "unsupported" | "timeout" | "error";
	elapsedMs: number;
	polls: number;
	error?: string;
}

export const LIVE_TOOL_LIST_TIMEOUT_MS = 3_000;
export const LIVE_TOOL_LIST_POLL_MS = 20;

function listsAll(server: ChildServerStatus, sdkNames: readonly string[], piNames: readonly string[]): boolean {
	const listed = new Set((server.tools ?? []).map((tool) => tool.name));
	// Claude Code reports server-local tool names; accept the prefixed form too.
	return piNames.every((name, index) => listed.has(name) || listed.has(sdkNames[index]));
}

/**
 * Resolve once the child lists `piNames` (the Pi tool names; `sdkNames` the names
 * Claude calls them by, same order) on `serverName`, or when that cannot or did
 * not happen within `timeoutMs`. Never rejects.
 */
export async function waitForChildToolList(
	lister: ChildToolLister,
	serverName: string,
	piNames: readonly string[],
	sdkNames: readonly string[],
	options: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChildToolListOutcome> {
	const timeoutMs = options.timeoutMs ?? LIVE_TOOL_LIST_TIMEOUT_MS;
	const pollMs = options.pollMs ?? LIVE_TOOL_LIST_POLL_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const started = now();
	let polls = 0;
	for (;;) {
		polls += 1;
		let servers: ChildServerStatus[];
		try {
			servers = await lister.mcpServerStatus();
		} catch (error) {
			return { outcome: "error", elapsedMs: now() - started, polls, error: error instanceof Error ? error.message : String(error) };
		}
		const server = Array.isArray(servers) ? servers.find((entry) => entry?.name === serverName) : undefined;
		if (!server || !Array.isArray(server.tools)) return { outcome: "unsupported", elapsedMs: now() - started, polls };
		if (listsAll(server, sdkNames, piNames)) return { outcome: "listed", elapsedMs: now() - started, polls };
		if (now() - started >= timeoutMs) return { outcome: "timeout", elapsedMs: now() - started, polls };
		await sleep(pollMs);
	}
}
