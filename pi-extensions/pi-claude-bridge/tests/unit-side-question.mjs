/**
 * Side questions (/btw).
 *
 * Contract at the call site: a live query answers directly; with no live query
 * (or one that closed under us) a resumed child answers with the last turn's
 * options, `persistSession: false`, and a prompt stream that never yields, and
 * is closed afterwards. History is capped at Claude Code's 20 exchanges.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askSideQuestion, SIDE_QUESTION_HISTORY_LIMIT } from "../src/side-question.ts";

const session = { sessionId: "sess-1234abcd", cursor: 3, cwd: "/repo", claudeConfigDir: "/profiles/a" };
const base = {
	model: "claude-opus-5-5",
	cwd: "/repo",
	claudeConfigDir: "/profiles/a",
	buildOptions: () => ({ model: "claude-opus-5-5", cwd: "/repo", resume: "stale", mcpServers: { pi: {} } }),
};

function fakeResumedQuery(answer) {
	const calls = { asked: [], closed: false, promptYielded: false };
	let finish;
	const done = new Promise((resolve) => { finish = resolve; });
	const query = {
		async askSideQuestion(question, options) {
			calls.asked.push({ question, options });
			return typeof answer === "function" ? answer() : answer;
		},
		close() { calls.closed = true; finish(); },
		async *[Symbol.asyncIterator]() { await done; },
	};
	return { query, calls };
}

describe("side question", () => {
	it("asks the live query and never starts a second child", async () => {
		const live = { asked: [], async askSideQuestion(q, o) { this.asked.push({ q, o }); return { response: "PAPAYA-913", synthetic: false }; } };
		let spawned = 0;
		const answer = await askSideQuestion({ question: " codename? " }, {
			liveQuery: () => live,
			session: () => session,
			base: () => base,
			queryFactory: () => { spawned += 1; return {}; },
		});
		assert.deepEqual(answer, { text: "PAPAYA-913", synthetic: false, model: "claude-opus-5-5", path: "live" });
		assert.equal(live.asked[0].q, "codename?");
		assert.equal(spawned, 0);
	});

	it("resumes the shared session without persisting and closes the child", async () => {
		const { query, calls } = fakeResumedQuery({ response: "SKU-707 has 4" });
		let params;
		const answer = await askSideQuestion({ question: "SKU-707?" }, {
			liveQuery: () => null,
			session: () => session,
			base: () => base,
			queryFactory: (p) => { params = p; return query; },
		});
		assert.equal(answer.path, "resumed");
		assert.equal(answer.text, "SKU-707 has 4");
		assert.equal(params.options.resume, "sess-1234abcd");
		assert.equal(params.options.persistSession, false);
		assert.deepEqual(params.options.mcpServers, { pi: {} });
		assert.equal(calls.closed, true);
		const iterator = params.prompt[Symbol.asyncIterator]();
		const first = await Promise.race([iterator.next(), new Promise((r) => setTimeout(() => r("parked"), 20))]);
		assert.notEqual(first, "parked", "the prompt stream ends once the child is released");
		assert.equal(first.done, true, "the prompt stream never yields a user message");
	});

	it("falls back to resuming when the live query closed under the request", async () => {
		const live = { async askSideQuestion() { throw new Error("ProcessTransport is not ready for writing"); } };
		const { query } = fakeResumedQuery({ response: "resumed answer" });
		const answer = await askSideQuestion({ question: "q" }, {
			liveQuery: () => live,
			session: () => session,
			base: () => base,
			queryFactory: () => query,
		});
		assert.equal(answer.path, "resumed");
	});

	it("surfaces other live failures instead of silently resuming", async () => {
		const live = { async askSideQuestion() { throw new Error("rate limited"); } };
		await assert.rejects(
			askSideQuestion({ question: "q" }, { liveQuery: () => live, session: () => session, base: () => base, queryFactory: () => assert.fail("no resume") }),
			/rate limited/,
		);
	});

	it("refuses to resume before the first turn or after the session moved", async () => {
		const deps = { liveQuery: () => null, queryFactory: () => assert.fail("no child") };
		await assert.rejects(askSideQuestion({ question: "q" }, { ...deps, session: () => null, base: () => base }), /Send a message first/);
		await assert.rejects(askSideQuestion({ question: "q" }, { ...deps, session: () => session, base: () => null }), /Send a message first/);
		await assert.rejects(
			askSideQuestion({ question: "q" }, { ...deps, session: () => ({ ...session, claudeConfigDir: "/profiles/b" }), base: () => base }),
			/moved since the last turn/,
		);
	});

	it("replays at most the newest 20 exchanges", async () => {
		const history = Array.from({ length: 25 }, (_, i) => ({ question: `q${i}`, response: `a${i}` }));
		const { query, calls } = fakeResumedQuery({ response: "ok" });
		await askSideQuestion({ question: "q", history }, { liveQuery: () => null, session: () => session, base: () => base, queryFactory: () => query });
		const sent = calls.asked[0].options.history;
		assert.equal(sent.length, SIDE_QUESTION_HISTORY_LIMIT);
		assert.equal(sent[0].question, "q5");
	});

	it("rejects an empty question and an empty answer", async () => {
		const deps = { liveQuery: () => null, session: () => session, base: () => base };
		await assert.rejects(askSideQuestion({ question: "   " }, { ...deps, queryFactory: () => assert.fail() }), /Ask a question/);
		const { query, calls } = fakeResumedQuery(null);
		await assert.rejects(askSideQuestion({ question: "q" }, { ...deps, queryFactory: () => query }), /no answer/);
		assert.equal(calls.closed, true);
	});

	it("a configured side-question model answers on a resumed child, even mid-turn", async () => {
		const live = { async askSideQuestion() { assert.fail("the session model's live query is not used"); } };
		const { query, calls } = fakeResumedQuery({ response: "sonnet answer" });
		let params;
		let askedCwd;
		const answer = await askSideQuestion({ question: "q" }, {
			liveQuery: () => live,
			session: () => session,
			base: () => base,
			queryFactory: (p) => { params = p; return query; },
			sideQuestionModel: (cwd) => { askedCwd = cwd; return { model: "claude-sonnet-5-5", effort: "high" }; },
		});
		assert.deepEqual(answer, { text: "sonnet answer", synthetic: false, model: "claude-sonnet-5-5", path: "resumed" });
		assert.equal(askedCwd, "/repo");
		assert.equal(params.options.model, "claude-sonnet-5-5");
		assert.equal(params.options.effort, "high");
		assert.equal(params.options.resume, "sess-1234abcd");
		assert.equal(params.options.persistSession, false);
		assert.deepEqual(params.options.mcpServers, { pi: {} });
		assert.equal(calls.closed, true);
	});

	it("the session model answers when the configured model is the session model or fails", async () => {
		const live = { async askSideQuestion() { return { response: "session answer" }; } };
		const same = await askSideQuestion({ question: "q" }, {
			liveQuery: () => live, session: () => session, base: () => base,
			queryFactory: () => assert.fail("no child"),
			sideQuestionModel: () => ({ model: "claude-opus-5-5" }),
		});
		assert.equal(same.path, "live");
		const { query } = fakeResumedQuery(() => { throw new Error("Sonnet limit reached"); });
		const failed = await askSideQuestion({ question: "q" }, {
			liveQuery: () => live, session: () => session, base: () => base,
			queryFactory: () => query,
			sideQuestionModel: () => ({ model: "claude-sonnet-5-5" }),
		});
		assert.deepEqual(failed, { text: "session answer", synthetic: false, model: "claude-opus-5-5", path: "live" });
	});
});
