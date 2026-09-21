/**
 * Prompt-cache observability and stability.
 *
 * 1. Every syncSharedSession outcome leaves a `lastSync` audit on the shared
 *    session (persisted with the `claude-bridge-session` entry) naming the path
 *    taken and, for a rebuild, why. The 2026-09 cache post-mortem could only
 *    classify one third of the turn-start cache misses because the session
 *    file said nothing about whether the CLI transcript was resumed or rewritten.
 * 2. A tool whose description changes while its schema does not keeps its
 *    first-declared description within a session. Tool declarations lead the
 *    API request, so a description flip (pi-mcp-adapter re-registering `mcp`
 *    after a server connects) invalidated the whole prompt cache.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState } from "../src/bridge-state.ts";
import { resetPinnedToolDescriptions, resolveMcpTools } from "../src/index.ts";
import { syncSharedSession, takePendingCleanStartAudit } from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-sync-audit-"));
const cwd = join(root, "project");

beforeEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetPinnedToolDescriptions();
});
after(() => rmSync(root, { recursive: true, force: true }));

const shared = () => __testGetBridgeIntegrityState().sharedSession;

function history(turns) {
	const timestamp = Date.now();
	const messages = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: `prompt ${i}`, timestamp });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], stopReason: "stop", timestamp });
	}
	return messages;
}

describe("sync audit", () => {
	it("records a clean start for the provider to attach once the CLI names the session", () => {
		const result = syncSharedSession([{ role: "user", content: "first", timestamp: Date.now() }], cwd, undefined, "claude-opus-5", undefined, 1, "AGENTS");
		assert.equal(result.sessionId, null);
		const audit = takePendingCleanStartAudit();
		assert.equal(audit?.path, "clean");
		assert.equal(audit?.appendDigest?.length, 12);
		assert.equal(takePendingCleanStartAudit(), undefined, "taken once");
	});

	it("records a first rebuild, then a cache-safe reuse, then a drift rebuild with its reason", () => {
		const tools = new Map([["bash", "mcp__pi__bash"], ["read", "mcp__pi__read"]]);
		const first = syncSharedSession([...history(1), { role: "user", content: "second", timestamp: Date.now() }], cwd, tools, "claude-opus-5", undefined, 1, "AGENTS");
		assert.ok(first.sessionId);
		assert.deepEqual(
			{ path: shared().lastSync.path, reason: shared().lastSync.reason, priors: shared().lastSync.priors, tools: shared().lastSync.tools },
			{ path: "rebuild", reason: "first", priors: 2, tools: 2 },
		);

		// The provider advances the cursor to the prompt it just sent (u0 a0 u1 = 3);
		// pi then appends the answer, so the next turn misses only that assistant.
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), cursor: 3 } });
		const reuse = syncSharedSession([...history(2), { role: "user", content: "third", timestamp: Date.now() }], cwd, tools, "claude-opus-5", undefined, 1, "AGENTS");
		assert.equal(reuse.sessionId, first.sessionId);
		assert.equal(shared().lastSync.path, "reuse");
		assert.equal(shared().cursor, 4);

		// Two turns arrive that the CLI never saw (another provider took one).
		const drift = syncSharedSession([...history(4), { role: "user", content: "fifth", timestamp: Date.now() }], cwd, tools, "claude-opus-5", undefined, 1, "AGENTS");
		assert.equal(drift.sessionId, first.sessionId, "same account keeps the session id");
		assert.equal(shared().lastSync.path, "rebuild");
		assert.equal(shared().lastSync.reason, "drift");
		assert.equal(shared().lastSync.missed, 4);
		assert.equal(shared().lastSync.rotated, false);
		assert.equal(shared().rebuildReason, undefined, "the trigger is consumed by the rebuild");
	});

	it("names the trigger when the session was marked for rebuild", () => {
		const first = syncSharedSession([...history(1), { role: "user", content: "second", timestamp: Date.now() }], cwd, undefined, "claude-opus-5");
		__testSetBridgeIntegrityState({ sharedSession: { ...shared(), needsRebuild: true, forceRotate: true, rebuildReason: "abort" } });
		const rebuilt = syncSharedSession([...history(2), { role: "user", content: "third", timestamp: Date.now() }], cwd, undefined, "claude-opus-5");
		assert.notEqual(rebuilt.sessionId, first.sessionId, "post-abort rebuilds rotate the id");
		assert.equal(shared().lastSync.reason, "abort");
		assert.equal(shared().lastSync.rotated, true);
	});
});

describe("pinned tool descriptions", () => {
	const schema = { type: "object", properties: { q: { type: "string" } } };
	it("keeps the first description while the schema is unchanged and follows a schema change", () => {
		const first = resolveMcpTools({ tools: [{ name: "mcp", description: "gateway — paseo not connected", parameters: schema }] });
		assert.equal(first.mcpTools[0].description, "gateway — paseo not connected");

		const flipped = resolveMcpTools({ tools: [{ name: "mcp", description: "gateway — paseo (61 tools)", parameters: schema }] });
		assert.equal(flipped.mcpTools[0].description, "gateway — paseo not connected", "status-only description churn does not reach the API");

		const newSchema = { ...schema, properties: { ...schema.properties, connect: { type: "string" } } };
		const redefined = resolveMcpTools({ tools: [{ name: "mcp", description: "gateway v2", parameters: newSchema }] });
		assert.equal(redefined.mcpTools[0].description, "gateway v2", "a schema change is a real redefinition");

		resetPinnedToolDescriptions();
		const fresh = resolveMcpTools({ tools: [{ name: "mcp", description: "gateway — paseo (61 tools)", parameters: schema }] });
		assert.equal(fresh.mcpTools[0].description, "gateway — paseo (61 tools)", "a new session starts from the current description");
	});
});
