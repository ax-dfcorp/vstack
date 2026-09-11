import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { resetStack } from "../src/query-state.ts";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

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
const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };

function fakeSdkQuery(messages, accountLabel, observed) {
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) break;
				if (message instanceof Error) throw message;
				yield message;
			}
		},
		close() { closed = true; },
		async interrupt() { closed = true; },
		async accountInfo() {
			return { email: `${accountLabel}@example.com`, subscriptionType: "max" };
		},
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
			observed.usageProbes.push(accountLabel);
			return { subscription_type: "max", rate_limits_available: true, rate_limits: null };
		},
	};
}

function makeRouter(observed, options = {}) {
	const accounts = options.accounts ?? [
		{ profileId: "a", label: "account-a", configDir: "/profiles/a" },
		{ profileId: "b", label: "account-b", configDir: "/profiles/b" },
	];
	return {
		version: 1,
		acquire(input) {
			observed.acquires.push(input);
			if (options.unavailable) {
				const error = new Error("No Claude subscription account is available");
				if (options.resetAtMs) Object.assign(error, { resetAtMs: options.resetAtMs, rateLimitType: "all_accounts" });
				throw error;
			}
			const excluded = new Set(input.excludedProfileIds ?? []);
			const selected = accounts.find((account) => !excluded.has(account.profileId));
			if (!selected) throw new Error("All Claude accounts are cooling down");
			return selected;
		},
		recordIdentity(profileId, identity) { observed.identities.push({ profileId, identity }); },
		recordUsage(profileId) { observed.usageRecords.push(profileId); },
		recordRateLimit(profileId, info) {
			observed.rateLimits.push({ profileId, info });
			return Date.now() + 60_000;
		},
		recordFailure(profileId, kind) { observed.failures.push({ profileId, kind }); },
		recordSuccess(profileId) { observed.successes.push(profileId); },
		current() { return undefined; },
	};
}

function observedState() {
	return {
		acquires: [],
		queryEnvs: [],
		usageProbes: [],
		usageRecords: [],
		identities: [],
		rateLimits: [],
		failures: [],
		successes: [],
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
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

describe("managed account stream rotation", () => {
	it("retries a rejected pre-output request on the next profile without leaking the first attempt", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(((input) => {
			observed.queryEnvs.push(input.options.env);
			calls += 1;
			if (calls === 1) {
				return fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{
						type: "rate_limit_event",
						rate_limit_info: {
							status: "rejected",
							rateLimitType: "five_hour",
							resetsAt: new Date(Date.now() + 60_000).toISOString(),
						},
					},
					{
						type: "assistant",
						error: "rate_limit",
						message: {
							model: "<synthetic>",
							content: [{ type: "text", text: "You've hit your session limit" }],
							usage: { input_tokens: 0, output_tokens: 0 },
						},
					},
					{ type: "result", subtype: "success", result: "You've hit your session limit" },
				], "a", observed);
			}
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-b" },
				{ type: "result", subtype: "success", result: "ok-from-b" },
			], "b", observed);
		}));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 2);
		assert.equal(observed.acquires.length, 2);
		assert.deepEqual(observed.acquires[1].excludedProfileIds, ["a"]);
		assert.deepEqual(observed.queryEnvs.map((env) => env.CLAUDE_CONFIG_DIR), [
			"/profiles/a", "/profiles/b",
		]);
		assert.ok(observed.queryEnvs.every((env) => env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === undefined));
		assert.ok(observed.queryEnvs.every((env) => env.DISABLE_EXTRA_USAGE_COMMAND === undefined));
		assert.deepEqual(
			events.filter((event) => event.type === "text_delta").map((event) => event.delta),
			["ok-from-b"],
		);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(events.filter((event) => event.type === "start").length, 1);
		assert.equal(observed.rateLimits[0].profileId, "a");
		assert.deepEqual(observed.successes, ["b"]);
	});

	it("rotates on a pre-output model-scoped limit thrown by the SDK wrapper and rescopes the block", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(((input) => {
			observed.queryEnvs.push(input.options.env);
			calls += 1;
			if (calls === 1) {
				return fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					// The SDK enum has no Fable variant: the event is typed seven_day.
					{
						type: "rate_limit_event",
						rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(Date.now() / 1000) + 3600 },
					},
					{ type: "result", subtype: "error_during_execution", errors: ["You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."] },
					// …and then the iterator throws its friendly wrapper (2026-09-11 hym session).
					new Error("Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."),
				], "a", observed);
			}
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-b" },
				{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
				{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
				{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from-b" } } },
				{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
				{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
				{ type: "stream_event", event: { type: "message_stop" } },
				{ type: "assistant", message: { model: model.id, content: [{ type: "text", text: "from-b" }], usage: { input_tokens: 1, output_tokens: 1 } } },
				{ type: "result", subtype: "success", result: "from-b" },
			], "b", observed);
		}));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 2, "pre-output limit must move to the next account");
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "from-b"));
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(observed.rateLimits[0].info.rateLimitType, "seven_day", "the structured event is recorded as received");
		const rescoped = observed.rateLimits.find((entry) => entry.info.rateLimitType === "seven_day_fable");
		assert.ok(rescoped, "the limit is re-recorded with the family the message names");
		assert.equal(rescoped.profileId, "a");
		assert.equal(rescoped.info.resetsAt, observed.rateLimits[0].info.resetsAt, "the authoritative reset is kept");
	});

	it("rotates on a pre-output network failure", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory((input) => {
			observed.queryEnvs.push(input.options.env);
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					new Error("socket timeout before response"),
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "network-recovered" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "network-session" }));
		assert.equal(calls, 2);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "network-recovered"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("treats an Extra Usage rejection as a model limit and rotates accounts", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{ type: "assistant", error: "extra_usage_disabled" },
					{ type: "result", subtype: "success", result: "Extra usage is disabled" },
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "recovered-without-local-billing-policy" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "extra-usage-session" }));
		assert.equal(calls, 2);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "rate-limit" }]);
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "recovered-without-local-billing-policy"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("never replays after visible text has committed", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(((input) => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{
					type: "stream_event",
					event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } },
				},
				{
					type: "stream_event",
					event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				},
				{
					type: "stream_event",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "already-visible" } },
				},
				{
					type: "assistant",
					error: "rate_limit",
					message: { model: model.id, content: [{ type: "text", text: "already-visible" }], usage: { input_tokens: 1, output_tokens: 1 } },
				},
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				{ type: "result", subtype: "error_during_execution", errors: ["rate limit"] },
			], "a", observed);
		}));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 1);
		// The only second acquire is the auto-resume reservation for Pi's retry;
		// the bridge itself never starts another Claude Code attempt here.
		assert.equal(observed.acquires.length, 2);
		assert.equal(observed.acquires[1].reason, "auto-resume");
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "already-visible"));
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("surfaces a post-output rate limit in Pi's retryable form after reserving the next account", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(((input) => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{
					type: "stream_event",
					event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } },
				},
				{
					type: "stream_event",
					event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				},
				{
					type: "stream_event",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "already-visible" } },
				},
				// The SDK iterator's own wrapper for a terminal usage-limit result. Its
				// copy carries none of Pi's retryable words, so surfaced verbatim it
				// used to stop the run until the user typed `continue`.
				new Error("Claude Code returned an error result: You've hit your session limit · resets 1:50pm (Asia/Seoul)"),
			], "a", observed);
		}));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 1, "no bridge-side replay after committed output");
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "already-visible"));
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1);
		const errorMessage = errors[0].error.errorMessage;
		assert.match(errorMessage, /rate limit/i);
		assert.match(errorMessage, /account-b/);
		assert.match(errorMessage, /session limit/, "original SDK copy is kept for diagnosis");
		assert.ok(
			isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage }),
			`Pi must classify the surfaced error as retryable: ${errorMessage}`,
		);
		assert.equal(observed.acquires.length, 2);
		assert.deepEqual(observed.acquires[1].excludedProfileIds, ["a"]);
		assert.equal(observed.acquires[1].reason, "auto-resume");
		assert.equal(observed.acquires[1].forceRerank, true);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "rate-limit" }]);
	});

	it("keeps a post-output rate limit terminal when no other account can take the turn", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed, {
			accounts: [{ profileId: "a", label: "account-a", configDir: "/profiles/a" }],
		});
		const original = "Claude Code returned an error result: You've hit your session limit · resets 1:50pm (Asia/Seoul)";
		__testSetSdkQueryFactory((() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-a" },
			{
				type: "stream_event",
				event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "already-visible" } },
			},
			new Error(original),
		], "a", observed)));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].error.errorMessage, original);
		assert.equal(
			isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: original }),
			false,
			"Pi must not retry into the same exhausted pool",
		);
		assert.equal(observed.acquires.length, 2, "the reservation attempt is made and fails");
		assert.deepEqual(observed.acquires[1].excludedProfileIds, ["a"]);
	});

	it("records a post-output transport failure without replaying the request", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
				{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
				{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "committed" } } },
				new Error("socket timeout after output"),
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "post-output-network" }));
		assert.equal(calls, 1);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "committed"));
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("never replays after a child-executed connector call starts", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "connector-session" },
				{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
				{
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "connector-1", name: "mcp__claude_ai_Gmail__search_threads", input: {} },
					},
				},
				new Error("socket timeout after connector dispatch"),
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "connector-replay-boundary" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("uses Opus 4.8 only after the account router reports every Fable allowance spent", async () => {
		const observed = observedState();
		const fableModel = { ...model, id: "claude-fable-5", name: "Claude Fable 5" };
		const router = makeRouter(observed);
		router.acquire = (input) => {
			observed.acquires.push(input);
			return {
				profileId: "b",
				label: "account-b",
				configDir: "/profiles/b",
				modelId: "claude-opus-4-8",
				fallbackReason: "fable-quota",
			};
		};
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "opus-session" },
				{ type: "result", subtype: "success", result: "opus-after-fable" },
			], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(fableModel, context, { sessionId: "fable-spent" }));
		assert.equal(queryOptions.model, "claude-opus-4-8");
		assert.equal(queryOptions.fallbackModel, undefined);
		assert.equal(queryOptions.env.CLAUDE_CONFIG_DIR, "/profiles/b");
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "opus-after-fable"));
	});

	it("does not let SDK model fallback skip another managed Fable account", async () => {
		const observed = observedState();
		const fableModel = { ...model, id: "claude-fable-5", name: "Claude Fable 5" };
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "fable-session" },
				{ type: "result", subtype: "success", result: "fable-first" },
			], "a", observed);
		});

		await collect(streamClaudeAgentSdk(fableModel, context, { sessionId: "fable-ready" }));
		assert.equal(queryOptions.model, "claude-fable-5");
		assert.equal(queryOptions.fallbackModel, undefined);
	});

	it("surfaces an unavailable pool without starting Claude Code", async () => {
		const observed = observedState();
		const resetAtMs = Date.now() + 60_000;
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed, { unavailable: true, resetAtMs });
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			throw new Error("must not start");
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 0);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "error");
		assert.match(events[0].error.errorMessage, /No Claude subscription account/);
		assert.equal(events[0].error.resetAtMs, resetAtMs);
		assert.equal(events[0].error.rateLimitType, "all_accounts");
	});

	it("reports an already-aborted request without rotating", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{ type: "result", subtype: "success", result: "must-not-render" },
			], "a", observed);
		});
		const controller = new AbortController();
		controller.abort();
		const events = await collect(streamClaudeAgentSdk(model, context, {
			sessionId: "aborted-session",
			signal: controller.signal,
		}));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.equal(events.find((event) => event.type === "error")?.reason, "aborted");
	});

	it("rebuilds one stale Claude session after a pre-output context rejection", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetBridgeIntegrityState({
			sharedSession: {
				sessionId: "stale-session",
				cursor: 0,
				cwd: process.cwd(),
				accountProfileId: "a",
				claudeConfigDir: "/profiles/a",
			},
			ui: null,
		});
		const resumes = [];
		let calls = 0;
		__testSetSdkQueryFactory((input) => {
			resumes.push(input.options.resume);
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "stale-session" },
					{ type: "result", subtype: "error_during_execution", errors: ["Prompt is too long"] },
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "rebuilt-session" },
					{ type: "result", subtype: "success", result: "recovered-after-rebuild" },
				], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "context-rebuild-session" }));

		assert.equal(calls, 2);
		assert.deepEqual(resumes, ["stale-session", undefined]);
		assert.equal(observed.acquires.length, 2);
		assert.deepEqual(observed.acquires.map((input) => input.excludedProfileIds), [[], []]);
		assert.deepEqual(observed.failures, []);
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "recovered-after-rebuild"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("surfaces a canonical context rejection after exactly one rebuild", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetBridgeIntegrityState({
			sharedSession: {
				sessionId: "stale-session",
				cursor: 0,
				cwd: process.cwd(),
				accountProfileId: "a",
				claudeConfigDir: "/profiles/a",
			},
			ui: null,
		});
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: `session-${calls}` },
				{ type: "result", subtype: "error_during_execution", errors: ["Prompt is too long"] },
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "canonical-overflow-session" }));

		assert.equal(calls, 2);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.match(events.find((event) => event.type === "error")?.error.errorMessage ?? "", /Prompt is too long/);
	});

	it("does not rotate an unclassified invalid request", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{ type: "result", subtype: "error_during_execution", errors: ["invalid request shape"] },
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});
});
