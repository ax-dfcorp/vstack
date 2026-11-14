/**
 * A tool Pi activates during a query is callable in that same turn.
 *
 * A loader tool calls pi.setActiveTools from its execute(); Pi hands the larger
 * tool set to the provider with that call's result. The provider registers the
 * new tool on the query's live in-process MCP server (which notifies the child
 * with tools/list_changed) and releases the loader's result only after the
 * child's own view of the server lists the tool, so the next model request
 * already declares it (live-tools.ts).
 *
 * Drives the real streamClaudeAgentSdk against a fake SDK query. The child's MCP
 * side is a real MCP client connected to the bridge's server over an in-memory
 * transport, so tools/list, list_changed, and tools/call are the SDK's own.
 * No API calls.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "claude-bridge-live-tools-test-"));
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(scratch, "diag.log");
process.env.PI_CODING_AGENT_DIR = scratch;
const claudeConfigDir = join(scratch, "claude-profile");
const cwd = join(scratch, "project");
mkdirSync(cwd);

const { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } = await import("../src/index.ts");
const { CLAUDE_ACCOUNT_ROUTER_SYMBOL } = await import("../src/account-router.ts");
const { ctx, resetStack } = await import("../src/query-state.ts");
const { waitForChildToolList } = await import("../src/live-tools.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const objectSchema = (key) => ({ type: "object", properties: { [key]: { type: "string" } }, required: [key] });
const loaderTool = { name: "poc_loader", description: "Enable the vault tools.", parameters: objectSchema("query") };
const vaultTool = { name: "poc_vault_read", description: "Read one vault entry.", parameters: objectSchema("key") };

const LOADER_CALL = "toolu_live_loader";
const LOADER_ARGS = { query: "vault" };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const promptContext = { messages: [{ role: "user", content: "load the vault tools, then read alpha", timestamp: 1 }], tools: [loaderTool] };
function resultContext(tools) {
	return {
		tools,
		messages: [
			promptContext.messages[0],
			{ role: "assistant", content: [{ type: "toolCall", id: LOADER_CALL, name: "poc_loader", arguments: LOADER_ARGS }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: LOADER_CALL, toolName: "poc_loader", content: [{ type: "text", text: "Enabled: poc_vault_read" }], isError: false, timestamp: 3 },
		],
	};
}

const account = { profileId: "a", label: "account-a", configDir: claudeConfigDir };
const router = {
	version: 1,
	acquire() { return account; },
	recordIdentity() {},
	recordUsage() {},
	recordRateLimit() { return Date.now() + 60_000; },
	recordFailure() {},
	recordSuccess() {},
	current() { return undefined; },
};

let observed;

/** The fake child: blocks like a child waiting on an MCP handler, and answers
 *  mcpServerStatus from a real MCP client's tools/list. */
function installFactory({ statusTools = true } = {}) {
	__testSetSdkQueryFactory((input) => {
		const server = input.options.mcpServers?.["custom-tools"];
		observed.server = server;
		let release;
		const closedSignal = new Promise((resolve) => { release = resolve; });
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "0157bd00-0000-4000-8000-00000000live" };
				await closedSignal;
			},
			close() { if (!closed) { closed = true; release(); } },
			async interrupt() { this.close(); },
			async accountInfo() { return { email: "a@example.com", subscriptionType: "max" }; },
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
				return { subscription_type: "max", rate_limits_available: true, rate_limits: null };
			},
			async mcpServerStatus() {
				observed.timeline.push("status");
				// A real child answers after a control-channel round trip; slow enough
				// here that a result released without waiting would visibly come first.
				await new Promise((resolve) => setTimeout(resolve, 30));
				const { tools } = await observed.client.listTools();
				const names = tools.map((tool) => tool.name);
				observed.timeline.push(`listed:${names.join(",")}`);
				return [{ name: "custom-tools", status: "connected", ...(statusTools ? { tools: tools.map((tool) => ({ name: tool.name })) } : {}) }];
			},
		};
	});
}

async function connectChild() {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await observed.server.instance.connect(serverTransport);
	const client = new Client({ name: "fake-child", version: "1.0.0" });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => { observed.timeline.push("list_changed"); });
	await client.connect(clientTransport);
	observed.client = client;
}

/** Start the query and park the loader's MCP handler on it, the way the child
 *  waits for Pi to run the loader. */
async function startLoaderCall() {
	streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: "pi-session" });
	await new Promise((resolve) => setImmediate(resolve));
	const live = ctx();
	assert.ok(live.activeQuery, "the fresh query did not claim the context");
	await connectChild();
	live.recordToolCall(LOADER_CALL, "poc_loader", LOADER_ARGS);
	const loaderResult = observed.client.callTool({ name: "poc_loader", arguments: LOADER_ARGS }).then((result) => {
		observed.timeline.push("loader_result");
		return result;
	});
	for (let i = 0; i < 50 && !live.pendingToolCalls.has(LOADER_CALL); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(live.pendingToolCalls.has(LOADER_CALL), "the loader handler is not waiting for Pi");
	return { live, loaderResult };
}

async function endQuery(live) {
	live.activeQuery?.close();
	await live.waitForQuerySettlement();
	await observed.client?.close();
}

beforeEach(() => {
	observed = { timeline: [], server: undefined, client: undefined };
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	__testSetSdkQueryFactory();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("a tool Pi activates during a query", () => {
	it("is registered on the live server and the loader's result waits until the child lists it", async () => {
		installFactory();
		const { live, loaderResult } = await startLoaderCall();
		assert.deepEqual((await observed.client.listTools()).tools.map((tool) => tool.name), ["poc_loader"]);

		streamClaudeAgentSdk(model, resultContext([loaderTool, vaultTool]), { cwd, sessionId: "pi-session" });
		const result = await loaderResult;

		assert.equal(result.content[0].text, "Enabled: poc_vault_read");
		assert.deepEqual((await observed.client.listTools()).tools.map((tool) => tool.name).sort(), ["poc_loader", "poc_vault_read"]);
		const released = observed.timeline.indexOf("loader_result");
		assert.ok(observed.timeline.indexOf("list_changed") >= 0 && observed.timeline.indexOf("list_changed") < released, `list_changed must reach the child before the result: ${observed.timeline}`);
		const listed = observed.timeline.findIndex((event) => event.startsWith("listed:") && event.includes("poc_vault_read"));
		assert.ok(listed >= 0 && listed < released, `the result was released before the child listed the new tool: ${observed.timeline}`);
		assert.equal(live.liveMcpServer.toolNameToPi.get("mcp__custom-tools__poc_vault_read"), "poc_vault_read", "the stream cannot map the new tool's calls");
		await endQuery(live);
	});

	it("runs a call to the new tool through the same claim and Pi delivery as any other, under the same call id", async () => {
		installFactory();
		const { live, loaderResult } = await startLoaderCall();
		streamClaudeAgentSdk(model, resultContext([loaderTool, vaultTool]), { cwd, sessionId: "pi-session" });
		await loaderResult;

		live.recordToolCall("toolu_live_vault", "poc_vault_read", { key: "alpha" });
		const vaultResult = observed.client.callTool({ name: "poc_vault_read", arguments: { key: "alpha" } });
		for (let i = 0; i < 50 && !live.pendingToolCalls.has("toolu_live_vault"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(live.pendingToolCalls.has("toolu_live_vault"), "the new tool's handler did not claim its recorded call");

		const context = resultContext([loaderTool, vaultTool]);
		context.messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_live_vault", name: "poc_vault_read", arguments: { key: "alpha" } }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 4 },
			{ role: "toolResult", toolCallId: "toolu_live_vault", toolName: "poc_vault_read", content: [{ type: "text", text: "value of alpha: s1" }], isError: false, timestamp: 5 },
		);
		streamClaudeAgentSdk(model, context, { cwd, sessionId: "pi-session" });
		assert.equal((await vaultResult).content[0].text, "value of alpha: s1");
		assert.equal(live.liveMcpServer.toolNames.size, 2, "an already registered tool was registered again");
		await endQuery(live);
	});

	it("releases results at once when no tool was added", async () => {
		installFactory();
		const { live, loaderResult } = await startLoaderCall();
		streamClaudeAgentSdk(model, resultContext([loaderTool]), { cwd, sessionId: "pi-session" });
		await loaderResult;
		assert.equal(observed.timeline.includes("status"), false, "the child was polled although nothing changed");
		assert.equal(observed.timeline.includes("list_changed"), false);
		assert.equal(live.toolListReady, null);
		await endQuery(live);
	});

	it("does not hold results when the child reports no tool list", async () => {
		installFactory({ statusTools: false });
		const { live, loaderResult } = await startLoaderCall();
		const started = Date.now();
		streamClaudeAgentSdk(model, resultContext([loaderTool, vaultTool]), { cwd, sessionId: "pi-session" });
		await loaderResult;
		assert.ok(Date.now() - started < 1_000, "an unsupported child held the result for the whole bound");
		assert.equal(observed.timeline.filter((event) => event === "status").length, 1);
		await endQuery(live);
	});
});

describe("waitForChildToolList", () => {
	const fakeClock = () => {
		let t = 0;
		return { now: () => t, sleep: async (ms) => { t += ms; } };
	};
	const lister = (answers) => {
		let call = 0;
		return { async mcpServerStatus() { const answer = answers[Math.min(call++, answers.length - 1)]; if (answer instanceof Error) throw answer; return answer; } };
	};

	it("returns listed once every tool appears, by local or prefixed name", async () => {
		const result = await waitForChildToolList(lister([
			[{ name: "custom-tools", tools: [{ name: "a" }] }],
			[{ name: "custom-tools", tools: [{ name: "a" }, { name: "mcp__custom-tools__b" }] }],
		]), "custom-tools", ["b"], ["mcp__custom-tools__b"], fakeClock());
		assert.equal(result.outcome, "listed");
		assert.equal(result.polls, 2);
	});

	it("times out at the bound", async () => {
		const result = await waitForChildToolList(lister([[{ name: "custom-tools", tools: [] }]]), "custom-tools", ["b"], ["mcp__custom-tools__b"], { ...fakeClock(), timeoutMs: 100, pollMs: 20 });
		assert.equal(result.outcome, "timeout");
		assert.ok(result.elapsedMs >= 100);
	});

	it("stops at once when the server or its tool list is missing, or the request fails", async () => {
		assert.equal((await waitForChildToolList(lister([[{ name: "other", tools: [] }]]), "custom-tools", ["b"], ["x"], fakeClock())).outcome, "unsupported");
		assert.equal((await waitForChildToolList(lister([[{ name: "custom-tools" }]]), "custom-tools", ["b"], ["x"], fakeClock())).outcome, "unsupported");
		const failed = await waitForChildToolList(lister([new Error("closed")]), "custom-tools", ["b"], ["x"], fakeClock());
		assert.equal(failed.outcome, "error");
		assert.equal(failed.error, "closed");
	});
});
