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

export function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

export function extractUserPromptBlocks(
	messages: Context["messages"],
): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
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

export function deferredUserPromptToSdkInput(
	prompt: DeferredUserPrompt,
): string | AsyncGenerator<SDKUserMessage> {
	if (typeof prompt === "string" || !prompt.blocks) return deferredUserPromptText(prompt);
	return wrapPromptStream(prompt.blocks);
}
