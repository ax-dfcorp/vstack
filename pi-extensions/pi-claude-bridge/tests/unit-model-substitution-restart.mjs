/**
 * A model substitution inside a live query restarts it on a fresh Claude session.
 *
 * Claude Code's refusal fallback answers with another model than requested
 * (Opus 5.5 -> Opus 5) and keeps the swap for its session. The 2026-09-27 fix
 * only restarted on the next prompt, but steers and follow-ups kept one query
 * live for hours, so 652 turns of an Opus 5.5 session ran on Opus 5
 * (2026-09-29). The provider now discards the substituted query at the next pi
 * callback and re-runs the turn through a rebuilt, rotated session; after two
 * consecutive restarts that were substituted again it delivers normally and
 * says so once. The first query of a fresh pi session, which has no shared
 * session to mark, still rebuilds on the next prompt.
 *
 * Drives the real streamClaudeAgentSdk against a scripted fake SDK query. No
 * API calls.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "claude-bridge-model-substitution-restart-test-"));
const diagPath = join(scratch, "diag.log");
process.env.CLAUDE_BRIDGE_DIAG_PATH = diagPath;
process.env.PI_CODING_AGENT_DIR = scratch;
const claudeConfigDir = join(scratch, "claude-profile");
const cwd = join(scratch, "project");
mkdirSync(cwd);

const { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } = await import("../src/index.ts");
const { CLAUDE_ACCOUNT_ROUTER_SYMBOL } = await import("../src/account-router.ts");
const { modelSubstitutionStreak, resetModelSubstitutionStreak } = await import("../src/bridge-state.ts");
const { endToolUseTurn, updateTurnOutputModel } = await import("../src/assistant-stream.ts");
const { ctx, resetStack, toolCallDrainCause } = await import("../src/query-state.ts");

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const REQUESTED = "claude-opus-5-5";
const SUBSTITUTE = "claude-opus-5";
const model = {
	id: REQUESTED,
	name: "Claude Opus 5.5",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const OLD_SESSION_ID = "0157bd00-0000-4000-8000-000000000000";
const PI_SESSION = "pi-session";
const FALLBACK = { type: "system", subtype: "model_refusal_fallback", original_model: REQUESTED, fallback_model: SUBSTITUTE, scope: "session" };

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const promptContext = { messages: [{ role: "user", content: "run it", timestamp: 1 }] };

/** pi's context after `rounds` tool rounds, each a call and its result. */
function toolRoundsContext(rounds, extra = []) {
	const messages = [{ role: "user", content: "run it", timestamp: 1 }];
	for (let round = 1; round <= rounds; round++) {
		const id = toolCallId(round);
		messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${round}` } }], api: model.api, provider: model.provider, model: REQUESTED, usage, stopReason: "toolUse", timestamp: 2 * round },
			{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: `out ${round}` }], isError: false, timestamp: 2 * round + 1 },
		);
	}
	return { messages: [...messages, ...extra] };
}
const toolCallId = (round) => `toolu_substitution_${round}`;

const account = { profileId: "a", label: "account-a", configDir: claudeConfigDir };
const router = {
	version: 1,
	acquire() { return account; },
	recordIdentity() {},
	recordUsage() {},
	recordRateLimit() { return Date.now() + 60_000; },
	recordFailure(profileId, kind) { observed.failures.push({ profileId, kind }); },
	recordSuccess() {},
	current() { return undefined; },
};

let observed;

/** A fake SDK query that yields its script, then waits for pushed messages
 *  until closed, and ends after yielding a `result`. */
function scriptedQuery(script) {
	const queue = [...script];
	let wake;
	let closed = false;
	return {
		push(message) { queue.push(message); wake?.(); },
		async *[Symbol.asyncIterator]() {
			while (!closed) {
				if (queue.length > 0) {
					const message = queue.shift();
					yield message;
					if (message.type === "result") return;
					continue;
				}
				await new Promise((resolve) => { wake = resolve; });
				wake = undefined;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			observed.closes += 1;
			wake?.();
		},
		async interrupt() { this.close(); },
		async accountInfo() { return { email: "a@example.com", subscriptionType: "max" }; },
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
			return { subscription_type: "max", rate_limits_available: true, rate_limits: null };
		},
	};
}

/** `scripts[n]` is the script of the n-th query (default: the last one). */
function installFactory(scripts) {
	__testSetSdkQueryFactory((input) => {
		const index = observed.queries.length;
		const script = (scripts[index] ?? scripts.at(-1))(input.options.resume);
		const query = scriptedQuery(script);
		observed.queries.push({ resume: input.options.resume, query, prompt: undefined });
		input.prompt.next().then(({ value }) => {
			observed.queries[index].prompt = value?.message?.content?.map((block) => block.text ?? "").join("");
		});
		return query;
	});
}

const liveSubstituted = (resume) => [{ type: "system", subtype: "init", session_id: resume ?? OLD_SESSION_ID }, FALLBACK];
const answers = (text) => (resume) => [
	{ type: "system", subtype: "init", session_id: resume ?? "fresh-session" },
	{ type: "result", subtype: "success", result: text },
];

async function waitFor(check, label) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${label}`);
}

/** Parks one MCP handler on the live query, like a child waiting for pi to run
 *  its tool call. */
function parkHandler(round) {
	const live = ctx();
	const id = toolCallId(round);
	live.recordToolCall(id, "bash", { command: `echo ${round}` });
	return new Promise((resolve) => {
		live.pendingToolCalls.set(id, {
			toolName: "bash",
			resolve: (result) => {
				live.markToolResultResolved(id);
				resolve(result);
			},
		});
	});
}

function setSession(extra = {}) {
	__testSetBridgeIntegrityState({
		sharedSession: { sessionId: OLD_SESSION_ID, cursor: 1, cwd, accountProfileId: account.profileId, claudeConfigDir, ...extra },
	});
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function diagEntries(label) {
	let text = "";
	try { text = readFileSync(diagPath, "utf8"); } catch {}
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.label === label);
}

const cappedNotices = () => observed.notices.filter((message) => /keeps answering/.test(message));
const substitutionNotices = () => observed.notices.filter((message) => /answered with .* instead of/.test(message));

beforeEach(() => {
	observed = { queries: [], closes: 0, failures: [], notices: [] };
	writeFileSync(diagPath, "");
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
	resetStack();
	resetModelSubstitutionStreak();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: (message) => observed.notices.push(message) } });
});

afterEach(async () => {
	for (const { query } of observed.queries) query.close();
	await ctx().waitForQuerySettlement();
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	__testSetSdkQueryFactory();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("model substitution during an active query", () => {
	it("(a) discards the substituted query at the next tool round and re-runs on a fresh Claude session", async () => {
		installFactory([() => [{ type: "system", subtype: "init", session_id: OLD_SESSION_ID }], answers("continued on a fresh session")]);
		streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION });
		await waitFor(() => ctx().childSessionId === OLD_SESSION_ID, "the live query's init");
		setSession();
		const handler = parkHandler(1);
		observed.queries[0].query.push(FALLBACK);
		await waitFor(() => ctx().pendingModelSubstitution !== null, "the substitution");

		// The existing 09-27 mark is kept on the shared session.
		const marked = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(marked.needsRebuild, true);
		assert.equal(marked.forceRotate, true);
		assert.equal(marked.rebuildReason, "model-substitution");

		const events = await collect(streamClaudeAgentSdk(model, toolRoundsContext(1), { cwd, sessionId: PI_SESSION }));

		// The result was not delivered into the substituted query.
		const drained = await handler;
		assert.equal(drained.isError, true);
		assert.match(drained.content[0].text, /substituted model/);
		assert.ok(observed.closes >= 1, "the substituted query was not closed");

		// The re-run rebuilt a rotated session: a new id, never a resume of the swapped one.
		assert.equal(observed.queries.length, 2);
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "model-substitution");
		assert.equal(session.lastSync.rotated, true);
		assert.ok(observed.queries[1].resume, "the re-run did not resume the rebuilt session");
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID);
		assert.notEqual(session.sessionId, OLD_SESSION_ID);

		const [restart] = diagEntries("model_substitution_restart");
		assert.ok(restart, "no model_substitution_restart diag entry");
		assert.equal(restart.requested, REQUESTED);
		assert.equal(restart.reported, SUBSTITUTE);
		assert.equal(restart.sessionId, OLD_SESSION_ID.slice(0, 8));
		assert.equal(restart.contextMessages, 3);
		assert.equal(restart.waitingToolCalls, 1);
		assert.equal(diagEntries("tool_result_delivery_mismatch").length, 0, "the deliberate restart was reported as a mismatch");

		// pi gets the re-run's answer under the requested model id.
		assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["continued on a fresh session"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).message.model, REQUESTED);
		assert.deepEqual(observed.failures, [], "a deliberate restart was recorded as an account failure");
		assert.equal(substitutionNotices().length, 1);
	});

	it("(a) restarts the first query of a fresh pi session from its child session id", async () => {
		installFactory([liveSubstituted, answers("continued on a fresh session")]);
		streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION });
		await waitFor(() => ctx().pendingModelSubstitution !== null, "the substitution");
		assert.equal(__testGetBridgeIntegrityState().sharedSession, null);
		const handler = parkHandler(1);

		const events = await collect(streamClaudeAgentSdk(model, toolRoundsContext(1), { cwd, sessionId: PI_SESSION }));

		assert.equal((await handler).isError, true);
		assert.equal(observed.queries.length, 2);
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "model-substitution");
		assert.equal(session.lastSync.rotated, true);
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID);
		assert.equal(events.at(-1).type, "done");
	});

	it("(a) carries a steer queued with the tool results into the re-run as its prompt", async () => {
		installFactory([liveSubstituted, answers("answered the steer")]);
		streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION });
		await waitFor(() => ctx().pendingModelSubstitution !== null, "the substitution");
		setSession();
		parkHandler(1);

		const steer = { role: "user", content: "also check the logs", timestamp: 9 };
		const events = await collect(streamClaudeAgentSdk(model, toolRoundsContext(1, [steer]), { cwd, sessionId: PI_SESSION }));

		assert.equal(observed.queries.length, 2);
		await waitFor(() => observed.queries[1].prompt !== undefined, "the re-run prompt");
		assert.match(observed.queries[1].prompt, /also check the logs/);
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID);
		assert.equal(events.at(-1).type, "done");
	});

	it("(b) stops restarting after two consecutive substituted restarts and says so once", async () => {
		installFactory([liveSubstituted]);
		streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION });
		await waitFor(() => ctx().pendingModelSubstitution !== null, "the substitution");
		setSession();

		// Rounds 1 and 2: each delivery restarts, and each re-run is substituted again.
		const handler1 = parkHandler(1);
		streamClaudeAgentSdk(model, toolRoundsContext(1), { cwd, sessionId: PI_SESSION });
		assert.equal((await handler1).isError, true);
		await waitFor(() => observed.queries.length === 2 && ctx().pendingModelSubstitution !== null, "restart 1 substituted");
		assert.equal(modelSubstitutionStreak.restarts, 1);

		const handler2 = parkHandler(2);
		streamClaudeAgentSdk(model, toolRoundsContext(2), { cwd, sessionId: PI_SESSION });
		assert.equal((await handler2).isError, true);
		await waitFor(() => observed.queries.length === 3 && ctx().pendingModelSubstitution !== null, "restart 2 substituted");
		assert.equal(modelSubstitutionStreak.restarts, 2);
		assert.notEqual(observed.queries[2].resume, observed.queries[1].resume, "restart 2 reused restart 1's session");

		// Round 3: capped — the result is delivered into the live query.
		const handler3 = parkHandler(3);
		streamClaudeAgentSdk(model, toolRoundsContext(3), { cwd, sessionId: PI_SESSION });
		const delivered = await handler3;
		assert.equal(delivered.isError, false);
		assert.deepEqual(delivered.content, [{ type: "text", text: "out 3" }]);
		assert.equal(observed.queries.length, 3, "a capped substitution still restarted");

		// Round 4: substituted again on the same query — still delivered, no second notice.
		observed.queries[2].query.push(FALLBACK);
		await waitFor(() => ctx().pendingModelSubstitution !== null, "round 4 substitution");
		const handler4 = parkHandler(4);
		streamClaudeAgentSdk(model, toolRoundsContext(4), { cwd, sessionId: PI_SESSION });
		assert.equal((await handler4).isError, false);
		assert.equal(observed.queries.length, 3);

		assert.equal(diagEntries("model_substitution_restart").length, 2);
		const capped = diagEntries("model_substitution_restart_capped");
		assert.equal(capped.length, 1);
		assert.equal(capped[0].requested, REQUESTED);
		assert.equal(capped[0].reported, SUBSTITUTE);
		assert.equal(cappedNotices().length, 1);
		assert.match(cappedNotices()[0], /Opus 5\b.*instead of .*Opus 5\.5.* after 2 restarts; the session continues on .*until you restart the agent or switch model/);
		assert.equal(substitutionNotices().length, 1, "every restart of one streak warned again");

		// The requested id stays in pi history for every round.
		assert.equal(ctx().turnOutput.model, REQUESTED);
	});

	it("(b) a turn answered by the requested model resets the streak; a refusal turn does not", () => {
		modelSubstitutionStreak.restarts = 2;
		modelSubstitutionStreak.capNotified = true;
		const c = ctx();
		const fakeStream = () => ({ push() {}, end() {} });

		// A refusal-fallback turn opens on the requested model, then switches.
		c.resetTurnState(model);
		c.currentPiStream = fakeStream();
		updateTurnOutputModel(REQUESTED);
		updateTurnOutputModel(SUBSTITUTE, "fallback");
		endToolUseTurn(c);
		assert.equal(modelSubstitutionStreak.restarts, 2);
		assert.equal(modelSubstitutionStreak.capNotified, true);

		c.resetTurnState(model);
		c.currentPiStream = fakeStream();
		updateTurnOutputModel(REQUESTED);
		endToolUseTurn(c);
		assert.equal(modelSubstitutionStreak.restarts, 0);
		assert.equal(modelSubstitutionStreak.capNotified, false);
	});

	it("(b) the streak is per pi session", async () => {
		modelSubstitutionStreak.restarts = 2;
		modelSubstitutionStreak.piSessionId = "other-pi-session";
		installFactory([answers("hello")]);
		await collect(streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION }));
		assert.equal(modelSubstitutionStreak.restarts, 0);
		assert.equal(modelSubstitutionStreak.piSessionId, PI_SESSION);
	});

	it("(c) a substituted first query with no shared session still rebuilds a fresh session on the next prompt", async () => {
		installFactory([
			() => [{ type: "system", subtype: "init", session_id: OLD_SESSION_ID }, FALLBACK, { type: "result", subtype: "success", result: "answered on the substitute" }],
			answers("answered on a fresh session"),
		]);
		const first = await collect(streamClaudeAgentSdk(model, promptContext, { cwd, sessionId: PI_SESSION }));
		assert.equal(first.at(-1).type, "done");
		assert.equal(first.at(-1).message.model, REQUESTED);

		const marked = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(marked.sessionId, OLD_SESSION_ID);
		assert.equal(marked.needsRebuild, true, "the completed substituted query left a reusable session");
		assert.equal(marked.forceRotate, true);
		assert.equal(marked.rebuildReason, "model-substitution");

		const next = {
			messages: [
				...promptContext.messages,
				{ role: "assistant", content: [{ type: "text", text: "answered on the substitute" }], api: model.api, provider: model.provider, model: REQUESTED, usage, stopReason: "stop", timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			],
		};
		const second = await collect(streamClaudeAgentSdk(model, next, { cwd, sessionId: PI_SESSION }));
		assert.equal(second.at(-1).type, "done");
		assert.equal(observed.queries.length, 2);
		assert.ok(observed.queries[1].resume, "the next prompt did not resume the rebuilt session");
		assert.notEqual(observed.queries[1].resume, OLD_SESSION_ID, "the next prompt resumed the swapped session");
		const session = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(session.lastSync.path, "rebuild");
		assert.equal(session.lastSync.reason, "model-substitution");
		assert.equal(session.lastSync.rotated, true);
	});
});

describe("model-substitution-restart cause", () => {
	it("outranks the compaction flag it is set with, and ranks below an abort", () => {
		assert.equal(toolCallDrainCause({ compactionRestart: true, modelSubstitutionRestart: true }), "model-substitution-restart");
		assert.equal(toolCallDrainCause({ compactionRestart: true }), "compaction-restart");
		assert.equal(toolCallDrainCause({ compactionRestart: true, modelSubstitutionRestart: true, wasAborted: true }), "abort");
	});
});
