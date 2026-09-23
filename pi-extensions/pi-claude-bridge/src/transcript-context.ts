// Pi 0.86+ TranscriptContext → the Context shape the bridge is written against.
//
// pi-ai 0.86 folds `systemPrompt` and `tools` into a leading `role: "system"`
// message before calling a provider, and a session may add later system
// messages that patch prompt sections or the tool set. The bridge replaces
// Pi's prompt with the Claude Code preset and re-offers Pi's tools over MCP, so
// it needs the CURRENT prompt text and tools, and a message list whose indices
// match what Pi <=0.85 passed: session cursors, fingerprints, and every
// role-based scan are numbered over non-system messages.
//
// The helpers come from Pi's own transcript replay (`@earendil-works/pi-ai`
// root export since 0.86). They are read off the namespace because the bundle
// keeps pi-ai external: a named import would fail to link on a 0.81-0.85 host,
// which never produces system messages and so never reaches them.

import * as piAi from "@earendil-works/pi-ai";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";

type TranscriptReplay = {
	getCurrentSystemPrompt(messages: readonly { role: string }[]): string;
	getCurrentTools(messages: readonly { role: string }[]): Tool[];
};

function hasSystemMessage(messages: readonly { role: string }[]): boolean {
	return messages.some((message) => message.role === "system");
}

export function withoutSystemMessages<T extends { role: string }>(messages: T[]): T[] {
	return hasSystemMessage(messages) ? messages.filter((message) => message.role !== "system") : messages;
}

export function toLegacyContext(context: { messages: Message[]; systemPrompt?: string; tools?: Tool[] }): Context {
	const raw = context as Context;
	if (!hasSystemMessage(raw.messages)) return raw;
	const replay = piAi as unknown as Partial<TranscriptReplay>;
	if (typeof replay.getCurrentSystemPrompt !== "function" || typeof replay.getCurrentTools !== "function") {
		throw new Error("pi-claude-bridge: the host sent system messages but its pi-ai has no transcript replay helpers");
	}
	const systemPrompt = replay.getCurrentSystemPrompt(raw.messages) || raw.systemPrompt;
	const tools = replay.getCurrentTools(raw.messages);
	return {
		...(systemPrompt ? { systemPrompt } : {}),
		...(tools.length > 0 ? { tools } : raw.tools ? { tools: raw.tools } : {}),
		messages: withoutSystemMessages(raw.messages),
	};
}
