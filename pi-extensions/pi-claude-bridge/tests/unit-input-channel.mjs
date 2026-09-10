/**
 * The query's open input stream.
 *
 * Contract that matters at the call site: it yields the initial prompt, then
 * PARKS instead of finishing (a finished iterable makes the SDK close the
 * child's stdin, which is exactly what makes a steer impossible), yields
 * anything pushed while parked, and only completes on close(). consumeQuery
 * closing it at `result` is therefore what ends the query, not bookkeeping.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueryInputChannel } from "../src/input-channel.ts";

const text = (t) => [{ type: "text", text: t }];
const textOf = (msg) => msg.message.content.map((b) => b.text).join("");

/** Resolves to the value, or to "parked" when the iterator is still waiting. */
async function nextOrParked(iterator, ms = 25) {
	return Promise.race([
		iterator.next(),
		new Promise((resolve) => setTimeout(() => resolve("parked"), ms)),
	]);
}

describe("query input channel", () => {
	it("yields the initial prompt first", async () => {
		const channel = createQueryInputChannel(text("first prompt"));
		const first = await channel.stream.next();
		assert.equal(first.done, false);
		assert.equal(first.value.type, "user");
		assert.equal(first.value.parent_tool_use_id, null);
		assert.equal(textOf(first.value), "first prompt");
	});

	it("parks after the initial prompt instead of ending the input stream", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		assert.equal(await nextOrParked(channel.stream), "parked");
		assert.equal(channel.closed, false);
	});

	it("delivers a steer pushed while parked", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		const pending = channel.stream.next();
		assert.equal(channel.push(text("stop and do this instead")), true);
		const steer = await pending;
		assert.equal(textOf(steer.value), "stop and do this instead");
		assert.equal(channel.injectedCount, 1);
	});

	it("preserves image blocks on an injected steer", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		const pending = channel.stream.next();
		const blocks = [
			{ type: "text", text: "look at this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		];
		channel.push(blocks);
		const steer = await pending;
		assert.deepEqual(steer.value.message.content, blocks);
	});

	it("delivers steers pushed before the consumer asked, in order", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		channel.push(text("one"));
		channel.push(text("two"));
		assert.equal(textOf((await channel.stream.next()).value), "one");
		assert.equal(textOf((await channel.stream.next()).value), "two");
		assert.equal(channel.injectedCount, 2);
	});

	it("completes on close, which is what closes the child's stdin", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		const pending = channel.stream.next();
		channel.close();
		assert.equal((await pending).done, true);
		assert.equal(channel.closed, true);
	});

	it("still drains what was already queued when close races a push", async () => {
		const channel = createQueryInputChannel(text("first"));
		await channel.stream.next();
		channel.push(text("queued before close"));
		channel.close();
		assert.equal(textOf((await channel.stream.next()).value), "queued before close");
		assert.equal((await channel.stream.next()).done, true);
	});

	it("rejects a push after close so the caller falls back to replay", async () => {
		const channel = createQueryInputChannel(text("first"));
		channel.close();
		assert.equal(channel.push(text("too late")), false);
		assert.equal(channel.injectedCount, 0);
	});

	it("is idempotent on repeated close", async () => {
		const channel = createQueryInputChannel(text("first"));
		channel.close();
		channel.close();
		assert.equal(channel.closed, true);
	});
});
