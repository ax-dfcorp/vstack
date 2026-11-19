// Compact first when the user returns to a large conversation whose prompt
// cache expired: decision, session reading, settings, and the input handler.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testIdleCompact, __testKeepWarm } from "../src/index.ts";
import { setLastTopLevelRequest } from "../src/bridge-state.ts";
import {
	CACHE_WARM_CUSTOM_TYPE,
	DEFAULT_IDLE_COMPACT,
	idleCompactEnvOverride,
	idleCompactRefusal,
	idleCompactSettings,
	mergeCacheActivity,
	readSessionCacheActivity,
	runCompaction,
} from "../src/idle-compact.ts";
import { loadConfig, normalizeIdleCompact, resolveExternalConfigValue } from "../src/config.ts";

const MIN = 60_000;
const FABLE = "claude-fable-5-2";
const ON = { ...DEFAULT_IDLE_COMPACT, enabled: true };
const ACTIVITY = { at: 0, model: FABLE, contextTokens: 400_000 };

function state(patch = {}) {
	return { settings: ON, model: FABLE, idle: true, streaming: false, source: "rpc", inFlight: false, activity: ACTIVITY, compactedSince: false, now: 61 * MIN, ...patch };
}

describe("idleCompactRefusal", () => {
	it("is due for a large idle Fable conversation whose cache expired", () => assert.equal(idleCompactRefusal(state()), undefined));
	it("is due for typed input too", () => assert.equal(idleCompactRefusal(state({ source: "interactive" })), undefined));
	const cases = [
		["off by default", { settings: DEFAULT_IDLE_COMPACT }],
		["already running", { inFlight: true }],
		["steer into a running turn", { streaming: true }],
		["Pi busy", { idle: false }],
		["input from an extension", { source: "extension" }],
		["model not configured (Opus by default)", { model: "claude-opus-5-5", activity: { ...ACTIVITY, model: "claude-opus-5-5" } }],
		["no bridge model", { model: undefined }],
		["no earlier request", { activity: undefined }],
		["compacted since", { compactedSince: true }],
		["last request on another model", { activity: { ...ACTIVITY, model: "claude-opus-5-5" } }],
		["small context", { activity: { ...ACTIVITY, contextTokens: ON.minContextTokens - 1 } }],
		["cache still warm at 59 minutes", { now: 59 * MIN }],
		["a notice within the hour", { source: "rpc", now: 30 * MIN }],
	];
	for (const [name, patch] of cases) it(`refuses: ${name}`, () => assert.ok(idleCompactRefusal(state(patch))));
	it("applies to Opus when configured", () => {
		const settings = { ...ON, models: ["claude-opus-5-5"] };
		assert.equal(idleCompactRefusal(state({ settings, model: "claude-opus-5-5", activity: { ...ACTIVITY, model: "claude-opus-5-5" } })), undefined);
	});
});

function assistant(at, usage, extra = {}) {
	return { type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "pi-claude", model: FABLE, timestamp: at, usage, ...extra } };
}
const USAGE = { input: 10, output: 500, cacheRead: 300_000, cacheWrite: 99_490 };

describe("readSessionCacheActivity", () => {
	it("takes the last bridge request with usage", () => {
		const view = readSessionCacheActivity([
			{ type: "message", message: { role: "user", timestamp: 1 } },
			assistant(1_000, { ...USAGE, cacheRead: 1 }),
			assistant(2_000, USAGE),
			assistant(3_000, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "aborted" }),
			{ type: "message", message: { role: "assistant", provider: "pi-codex", model: "gpt", timestamp: 4_000, usage: USAGE } },
		]);
		assert.deepEqual(view, { activity: { at: 2_000, model: FABLE, contextTokens: 400_000 }, compactedSince: false });
	});
	it("accepts the legacy provider id", () => {
		const entry = assistant(2_000, USAGE);
		entry.message.provider = "claude-bridge";
		assert.equal(readSessionCacheActivity([entry]).activity?.at, 2_000);
	});
	it("a recorded warm-up of the same model moves the refresh time", () => {
		const view = readSessionCacheActivity([assistant(2_000, USAGE), { type: "custom", customType: CACHE_WARM_CUSTOM_TYPE, data: { at: 50_000, model: FABLE, cacheRead: 399_000 } }]);
		assert.equal(view.activity?.at, 50_000);
	});
	it("ignores a warm-up of another model or one older than the request", () => {
		assert.equal(readSessionCacheActivity([assistant(2_000, USAGE), { type: "custom", customType: CACHE_WARM_CUSTOM_TYPE, data: { at: 50_000, model: "claude-opus-5-5" } }]).activity?.at, 2_000);
		assert.equal(readSessionCacheActivity([{ type: "custom", customType: CACHE_WARM_CUSTOM_TYPE, data: { at: 1_000, model: FABLE } }, assistant(2_000, USAGE)]).activity?.at, 2_000);
	});
	it("sees a compaction after the last request", () => {
		assert.equal(readSessionCacheActivity([assistant(2_000, USAGE), { type: "compaction", timestamp: new Date(3_000).toISOString() }]).compactedSince, true);
		assert.equal(readSessionCacheActivity([{ type: "compaction" }, assistant(2_000, USAGE)]).compactedSince, false);
	});
	it("an empty branch has no activity", () => assert.deepEqual(readSessionCacheActivity([]), { activity: undefined, compactedSince: false }));
});

describe("mergeCacheActivity", () => {
	const session = { at: 1_000, model: FABLE, contextTokens: 400_000 };
	it("the later record of the same model wins", () => {
		assert.deepEqual(mergeCacheActivity(session, { at: 5_000, model: FABLE, contextTokens: 380_000 }), { at: 5_000, model: FABLE, contextTokens: 400_000 });
		assert.deepEqual(mergeCacheActivity(session, { at: 500, model: FABLE, contextTokens: 1 }), session);
	});
	it("a live record of another model does not count", () => assert.deepEqual(mergeCacheActivity(session, { at: 5_000, model: "claude-opus-5-5", contextTokens: 1 }), session));
	it("either alone", () => {
		assert.deepEqual(mergeCacheActivity(undefined, session), session);
		assert.deepEqual(mergeCacheActivity(session, undefined), session);
	});
});

describe("settings", () => {
	let saved;
	beforeEach(() => { saved = process.env.CLAUDE_BRIDGE_IDLE_COMPACT; delete process.env.CLAUDE_BRIDGE_IDLE_COMPACT; });
	afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_BRIDGE_IDLE_COMPACT; else process.env.CLAUDE_BRIDGE_IDLE_COMPACT = saved; });
	it("defaults: off, 60 minutes, Fable only", () => {
		const settings = idleCompactSettings(undefined, {});
		assert.equal(settings.enabled, false);
		assert.equal(settings.idleMinutes, 60);
		assert.deepEqual(settings.models, ["claude-fable-5-2", "claude-fable-5-1"]);
	});
	it("the environment switch wins both ways", () => {
		assert.equal(idleCompactSettings({ enabled: false }, { CLAUDE_BRIDGE_IDLE_COMPACT: "1" }).enabled, true);
		assert.equal(idleCompactSettings({ enabled: true }, { CLAUDE_BRIDGE_IDLE_COMPACT: "off" }).enabled, false);
		assert.equal(idleCompactEnvOverride({ CLAUDE_BRIDGE_IDLE_COMPACT: "maybe" }), undefined);
	});
	it("normalizes and bounds", () => {
		assert.deepEqual(normalizeIdleCompact({ enabled: true, idleMinutes: 5, minContextTokens: "300000", models: "claude-fable-5-2, claude-opus-5-5,," }), { enabled: true, idleMinutes: 60, minContextTokens: 300000, models: ["claude-fable-5-2", "claude-opus-5-5"] });
		assert.equal(normalizeIdleCompact({}), undefined);
		assert.equal(normalizeIdleCompact(null), undefined);
	});
	it("reads claude-bridge.json and resolves manifest keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "idle-compact-config-"));
		const savedDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { idleCompact: { enabled: true, minContextTokens: 250000 } } }));
			assert.deepEqual(loadConfig(dir).provider.idleCompact, { enabled: true, minContextTokens: 250000 });
			assert.equal(resolveExternalConfigValue("idleCompact.minContextTokens", dir).value, 250000);
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ "idleCompact.enabled": true }));
			assert.deepEqual(loadConfig(dir).provider.idleCompact, { enabled: true });
		} finally {
			if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runCompaction", () => {
	it("settles with the compaction result", async () => {
		assert.deepEqual(await runCompaction((o) => setTimeout(() => o.onComplete({ tokensBefore: 400_000 }), 1), () => undefined), { kind: "compacted", tokensBefore: 400_000 });
	});
	it("a failure lets the message go on the full context", async () => {
		assert.deepEqual(await runCompaction((o) => o.onError(new Error("Compaction failed: 529")), () => ({ aborted: false, fromExtension: false })), { kind: "failed", error: "Compaction failed: 529" });
	});
	it("only the user's abort counts as cancelled", async () => {
		assert.deepEqual(await runCompaction((o) => o.onError(new Error("Compaction cancelled")), () => ({ aborted: true, fromExtension: false })), { kind: "cancelled" });
		assert.equal((await runCompaction((o) => o.onError(new Error("Compaction cancelled")), () => ({ aborted: true, fromExtension: true }))).kind, "failed");
	});
	it("a throwing compact is a failure", async () => {
		assert.equal((await runCompaction(() => { throw new Error("no model"); }, () => undefined)).kind, "failed");
	});
});

describe("input handler", () => {
	let saved;
	beforeEach(() => { saved = process.env.CLAUDE_BRIDGE_IDLE_COMPACT; setLastTopLevelRequest(null); __testKeepWarm().cancel(); });
	afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_BRIDGE_IDLE_COMPACT; else process.env.CLAUDE_BRIDGE_IDLE_COMPACT = saved; setLastTopLevelRequest(null); });

	function fakeCtx({ lastAt = Date.now() - 90 * MIN, context = USAGE, model = FABLE, compact } = {}) {
		const calls = [];
		const branch = [assistant(lastAt, context)];
		return {
			calls,
			ctx: {
				cwd: tmpdir(),
				model: { provider: "pi-claude", id: model },
				isIdle: () => true,
				hasPendingMessages: () => false,
				sessionManager: { getBranch: () => branch },
				compact: (options) => { calls.push("compact"); (compact ?? ((o) => setTimeout(() => o.onComplete({ tokensBefore: 400_000 }), 1)))(options); },
			},
		};
	}

	it("does nothing while switched off", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "0";
		const { ctx, calls } = fakeCtx();
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "continue" });
		assert.deepEqual(calls, []);
	});
	it("compacts first, then lets the message through", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		const { ctx, calls } = fakeCtx();
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "continue" });
		assert.deepEqual(calls, ["compact"]);
	});
	it("a second input during the compaction is not held", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		let finish;
		const { ctx, calls } = fakeCtx({ compact: (o) => { finish = () => o.onComplete({}); } });
		const first = __testIdleCompact.run({ source: "rpc" }, ctx);
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "continue" });
		finish();
		assert.deepEqual(await first, { action: "continue" });
		assert.deepEqual(calls, ["compact"]);
	});
	it("a failed compaction sends the message unchanged", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		const { ctx } = fakeCtx({ compact: (o) => setTimeout(() => { __testIdleCompact.noteFailure({ aborted: false, fromExtension: false }); o.onError(new Error("Compaction failed: overloaded")); }, 1) });
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "continue" });
	});
	it("a compaction the user stopped drops the message", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		const { ctx } = fakeCtx({ compact: (o) => setTimeout(() => { __testIdleCompact.noteFailure({ aborted: true, fromExtension: false }); o.onError(new Error("Compaction cancelled")); }, 1) });
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "handled" });
	});
	it("no compaction while this process saw a request within the hour", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		setLastTopLevelRequest({ at: Date.now() - 10 * MIN, model: FABLE, contextTokens: 400_000 });
		const { ctx, calls } = fakeCtx();
		assert.deepEqual(await __testIdleCompact.run({ source: "rpc" }, ctx), { action: "continue" });
		assert.deepEqual(calls, []);
	});
	it("no compaction for a steer, a small context, or an Opus session", async () => {
		process.env.CLAUDE_BRIDGE_IDLE_COMPACT = "1";
		for (const [event, opts] of [[{ source: "rpc", streamingBehavior: "steer" }, {}], [{ source: "rpc" }, { context: { input: 1, output: 1, cacheRead: 1000, cacheWrite: 0 } }], [{ source: "rpc" }, { model: "claude-opus-5-5" }]]) {
			const { ctx, calls } = fakeCtx(opts);
			if (opts.model) ctx.sessionManager.getBranch()[0].message.model = opts.model;
			assert.deepEqual(await __testIdleCompact.run(event, ctx), { action: "continue" });
			assert.deepEqual(calls, []);
		}
	});
});
