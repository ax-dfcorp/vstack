// The user-input side of one SDK query, kept OPEN for the query's lifetime so
// a steer can reach the child while it is still working.
//
// Why this exists at all:
//   A string prompt sets the SDK's `isSingleUserTurn`, and the SDK then closes
//   the child's stdin as soon as the first `result` arrives — there is no way
//   to say anything to a run in progress. An AsyncIterable prompt leaves stdin
//   open until the iterable finishes, and the CLI coalesces anything written
//   meanwhile into its NEXT model turn. That is the same delivery boundary
//   pi's native providers use (steeringQueue drained per turn) and the same one
//   codex uses (`input_queue.get_pending_input()` before every model request).
//
//   The cost of holding input open is that the query no longer ends by itself:
//   consumeQuery must close the channel when the turn's `result` lands, or the
//   SDK stream never completes. That close is not optional bookkeeping — it is
//   what ends the query.
//
// Note the SDK already exercises the open-input path in production here (image
// prompts went through a one-shot generator), so this is a lifetime change, not
// a new mode.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

export interface QueryInputChannel {
	/** Pass as the query's `prompt`. Yields the initial prompt, then anything
	 *  pushed, then returns once closed (which closes the child's stdin). */
	readonly stream: AsyncGenerator<SDKUserMessage>;
	/** Messages written after the initial prompt — live steers. */
	readonly injectedCount: number;
	readonly closed: boolean;
	/** Returns false when the channel is already closed, so the caller can fall
	 *  back to replaying the message as a continuation query instead. */
	push(blocks: ContentBlockParam[]): boolean;
	close(): void;
}

function toSdkUserMessage(content: ContentBlockParam[]): SDKUserMessage {
	return {
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: { role: "user", content },
	} as SDKUserMessage;
}

export function createQueryInputChannel(initial: ContentBlockParam[]): QueryInputChannel {
	const queue: SDKUserMessage[] = [toSdkUserMessage(initial)];
	let wake: (() => void) | null = null;
	let closed = false;
	let injectedCount = 0;

	const stream = (async function* (): AsyncGenerator<SDKUserMessage> {
		for (;;) {
			while (queue.length > 0) yield queue.shift()!;
			if (closed) return;
			await new Promise<void>((resolve) => { wake = resolve; });
		}
	})();

	return {
		stream,
		get injectedCount() { return injectedCount; },
		get closed() { return closed; },
		push(blocks: ContentBlockParam[]): boolean {
			if (closed) return false;
			queue.push(toSdkUserMessage(blocks));
			injectedCount += 1;
			wake?.();
			wake = null;
			return true;
		},
		close(): void {
			if (closed) return;
			closed = true;
			wake?.();
			wake = null;
		},
	};
}
