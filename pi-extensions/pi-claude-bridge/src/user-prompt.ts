import type { Context } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { messageContentToText } from "./convert.js";

export interface StructuredDeferredUserPrompt {
	text: string;
	blocks: ContentBlockParam[] | null;
}

// String remains accepted for compatibility with queued state created by an
// older in-process module instance during an extension reload.
export type DeferredUserPrompt = string | StructuredDeferredUserPrompt;

/**
 * The run of user messages at the tail of the context, oldest first. The prompt is this
 * whole run, not only the last message: pi appends every steer that lands in the same tool
 * boundary as its own user message, so two Daseo subagent-finished notices 85 ms apart
 * (2026-10-13) became two trailing user messages, Claude received only the second, and the
 * first stayed in history as a prompt that was never sent.
 */
export function trailingUserMessages(messages: Context["messages"]): Context["messages"] {
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role === "user") start--;
	return messages.slice(start);
}

/** How many trailing messages the prompt consumes, for the session sync that imports the rest. */
export function trailingUserCount(messages: Context["messages"]): number {
	return trailingUserMessages(messages).length;
}

export function extractUserPrompt(messages: Context["messages"]): string | null {
	const tail = trailingUserMessages(messages);
	if (tail.length === 0) return null;
	const texts: string[] = [];
	for (const msg of tail) {
		const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content) || "";
		if (text) texts.push(text);
	}
	return texts.join("\n\n");
}

export function extractUserPromptBlocks(
	messages: Context["messages"],
): ContentBlockParam[] | null {
	const tail = trailingUserMessages(messages).filter((msg) => Array.isArray(msg.content));
	if (tail.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const msg of tail) {
		for (const block of msg.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image" && block.data && block.mimeType) {
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	return hasImage ? blocks : null;
}

export function extractDeferredUserPrompt(
	messages: Context["messages"],
): StructuredDeferredUserPrompt | null {
	const text = extractUserPrompt(messages) ?? "";
	const blocks = extractUserPromptBlocks(messages);
	return text || blocks ? { text, blocks } : null;
}

export async function* wrapPromptStream(
	blocks: ContentBlockParam[],
): AsyncGenerator<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks },
		parent_tool_use_id: null,
	};
}

export function deferredUserPromptText(prompt: DeferredUserPrompt): string {
	return typeof prompt === "string" ? prompt : prompt.text;
}

/** Content blocks for writing a steer straight into a live query's input
 *  channel. Images are preserved when the prompt carried any. */
export function deferredUserPromptToBlocks(prompt: DeferredUserPrompt): ContentBlockParam[] {
	if (typeof prompt === "string") return [{ type: "text", text: prompt }];
	if (prompt.blocks) return prompt.blocks;
	return [{ type: "text", text: prompt.text }];
}

export function deferredUserPromptToSdkInput(
	prompt: DeferredUserPrompt,
): string | AsyncGenerator<SDKUserMessage> {
	if (typeof prompt === "string" || !prompt.blocks) return deferredUserPromptText(prompt);
	return wrapPromptStream(prompt.blocks);
}
