#!/usr/bin/env node
// Threshold auto-compaction that fires INSIDE a tool loop must not deadlock.
//
// Pi 0.87 checks the compaction threshold before every assistant request
// (`_compactBeforeNextAssistantResponse`), including the one that delivers tool
// results. At that point the bridge has a live query whose MCP handler is
// waiting for the tool result. The summarization request used to enter the
// tool-result delivery path and be written into that live query as a steer:
// the child waited for a tool result, Pi waited for the summary, and the turn
// hung until the stream-idle timeout. Summaries now run as isolated one-shot
// queries (src/one-shot-summary.ts).
//
// Reproduction: one tool call whose output is large by Pi's chars/4 estimate
// but cheap in real tokens (runs of spaces). Phase 1 runs with compaction off
// and measures the real context of the tool-call response (X) and the final
// response (F). Phase 2 sets the threshold T between them so that
//   F < T < X + estimate(tool output)
// i.e. compaction fires exactly once — before the tool result is delivered —
// and the post-compaction final response does not trigger another.
//
// The bridge must then continue on the COMPACTED history: the live query
// (still on the pre-compaction transcript) is discarded and the turn re-runs
// through a rebuilt Claude session (rebuildReason=session_compact) with a fresh
// session id. Delivering the tool result into the live query instead kept the
// model on the full history and re-fired compaction after every tool round.

console.log("=== int-compact-mid-tool-loop.mjs ===");

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
// 780 lines of 63 spaces + "a": 49,920 bytes, under the bash tool's 50KB cap.
const COMMAND = "for i in $(seq 1 780); do printf '%64s\\n' a; done";
const PROMPT = [
	"I'm checking how a terminal renders right-aligned output. Please run this command with the bash tool, once:",
	COMMAND,
	"After it finishes, tell me in one short sentence how many lines it printed. Do not run anything else.",
].join("\n");

function contextTokens(usage) {
	return (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

function makeAgentDir(compaction) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-compact-loop-test-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction }));
	const realBridgeConfig = join(homedir(), ".pi", "agent", "claude-bridge.json");
	if (existsSync(realBridgeConfig)) copyFileSync(realBridgeConfig, join(agentDir, "claude-bridge.json"));
	return agentDir;
}

async function runPhase(name, compaction) {
	const harness = createRpcHarness({
		name,
		args: ["--model", BRIDGE_MODEL],
		env: { PI_CODING_AGENT_DIR: makeAgentDir(compaction) },
		defaultTimeout: TIMEOUT,
	});
	const assistants = [];
	const toolResults = [];
	const compactions = [];
	// Assistant messages and compaction ends in arrival order, to find the first
	// response after a compaction.
	const timeline = [];
	harness.start();
	harness.addListener((msg) => {
		if (msg.type === "message_end" && msg.message?.role === "assistant") {
			assistants.push(msg.message);
			timeline.push({ kind: "assistant", message: msg.message });
		}
		if (msg.type === "message_end" && msg.message?.role === "toolResult") toolResults.push(msg.message);
		if (msg.type === "compaction_start" || msg.type === "compaction_end") compactions.push(msg);
		if (msg.type === "compaction_end") timeline.push({ kind: "compaction_end" });
	});
	await new Promise((r) => setTimeout(r, 2000));
	const state = await harness.send({ type: "get_state" });
	const contextWindow = state?.model?.contextWindow;
	const startedAt = Date.now();
	try {
		await harness.promptAndWait(PROMPT);
	} finally {
		await harness.stop();
	}
	return {
		harness,
		contextWindow,
		assistants,
		toolResults,
		compactions,
		timeline,
		elapsedMs: Date.now() - startedAt,
		debugLog: readFileSync(harness.DEBUG_LOG, "utf8"),
	};
}

function toolResultChars(message) {
	return (message?.content ?? []).reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

let failed = false;
try {
	console.log("Phase 1: measure with compaction disabled...");
	const measure = await runPhase("compact-mid-tool-loop-measure", { enabled: false });
	const toolCall = measure.assistants.find((message) => message.stopReason === "toolUse");
	const final = measure.assistants.at(-1);
	if (!toolCall || !measure.toolResults.length || final?.stopReason !== "stop") {
		throw new Error(`phase 1 did not produce a tool call, a tool result, and a final answer: ${JSON.stringify(measure.assistants.map((m) => m.stopReason))}`);
	}
	const x = contextTokens(toolCall.usage);
	const f = contextTokens(final.usage);
	const toolEstimate = Math.ceil(toolResultChars(measure.toolResults[0]) / 4);
	console.log(`  contextWindow=${measure.contextWindow} X(tool-call context)=${x} F(final context)=${f} toolEstimate=${toolEstimate}`);
	const upper = x + toolEstimate;
	if (upper - f < 2000) {
		throw new Error(`no threshold window: F=${f} is within 2000 of X+estimate=${upper}; the reproduction needs a cheaper tool output`);
	}
	const threshold = Math.round((f + upper) / 2);
	if (!Number.isSafeInteger(measure.contextWindow)) throw new Error(`model contextWindow unavailable: ${measure.contextWindow}`);
	const reserveTokens = measure.contextWindow - threshold;
	console.log(`  threshold=${threshold} (reserveTokens=${reserveTokens}, keepRecentTokens=100)`);

	console.log("Phase 2: tool loop with a threshold that fires before the tool result is delivered...");
	const run = await runPhase("compact-mid-tool-loop", { enabled: true, reserveTokens, keepRecentTokens: 100 });
	const ends = run.compactions.filter((event) => event.type === "compaction_end");
	const oneShotLines = run.debugLog.split("\n").filter((line) => line.includes("provider: one-shot summary "));
	const idleTimeouts = run.debugLog.split("\n").filter((line) => line.includes("stream idle timeout"));
	const last = run.assistants.at(-1);
	console.log(`  elapsed=${run.elapsedMs}ms compactions=${ends.length} reasons=${JSON.stringify(ends.map((e) => e.reason))} final=${last?.stopReason}`);
	for (const line of oneShotLines) console.log(`  ${line.replace(/^\[[^\]]+\] \[[^\]]+\] /, "")}`);

	if (!run.assistants.some((message) => message.stopReason === "toolUse")) {
		throw new Error(`phase 2: the model did not call the tool, so nothing exercised the tool loop: ${last?.content?.find((b) => b.type === "text")?.text?.slice(0, 200)}`);
	}
	if (ends.length !== 1) throw new Error(`expected exactly one compaction, saw ${ends.length}`);
	if (ends[0].reason !== "threshold" || !ends[0].result || ends[0].aborted) {
		throw new Error(`compaction did not complete: ${JSON.stringify({ reason: ends[0].reason, aborted: ends[0].aborted, errorMessage: ends[0].errorMessage })}`);
	}
	if (!oneShotLines.some((line) => line.includes("activeQuery=true"))) {
		throw new Error("no one-shot summary ran beside a live query — compaction did not fire inside the tool loop");
	}
	if (idleTimeouts.length > 0) throw new Error(`stream idle timeout during the run: ${idleTimeouts[0]}`);
	if (last?.stopReason !== "stop") throw new Error(`turn did not end normally: stopReason=${last?.stopReason} error=${last?.errorMessage}`);

	// The turn continued on the compacted history, not the live pre-compaction query.
	const compactionAt = run.timeline.findIndex((entry) => entry.kind === "compaction_end");
	const beforeCompaction = run.timeline.slice(0, compactionAt).filter((entry) => entry.kind === "assistant").at(-1)?.message;
	const afterCompaction = run.timeline.slice(compactionAt + 1).find((entry) => entry.kind === "assistant")?.message;
	const contextBefore = contextTokens(beforeCompaction?.usage);
	const contextAfter = contextTokens(afterCompaction?.usage);
	console.log(`  context before compaction=${contextBefore} first response after compaction=${contextAfter} threshold=${threshold}`);
	if (!afterCompaction) throw new Error("no assistant response after the compaction");
	if (contextAfter >= threshold) {
		throw new Error(`post-compaction context ${contextAfter} is not below the threshold ${threshold}: the turn continued on the uncompacted history`);
	}
	const debugLines = run.debugLog.split("\n");
	// This run's tool loop is the first query of a fresh pi session, so there is
	// no shared session yet and the rewrite is marked on the live query.
	const markPattern = /session_compact: marking needsRebuild on (?:live query, child )?session ([0-9a-f]{8})/;
	const markLine = debugLines.findIndex((line) => markPattern.test(line));
	if (markLine < 0) throw new Error("session_compact never marked the Claude session for rebuild");
	const sessionBefore = debugLines[markLine].match(markPattern)?.[1];
	const restartLine = debugLines.findIndex((line, i) => i > markLine && line.includes("provider: compaction during active query — restarting query on compacted history"));
	if (restartLine < 0) throw new Error("the live query was not restarted after the mid-loop compaction");
	const rebuildLine = debugLines.find((line, i) => i > restartLine && line.includes("syncResult: path=rebuild") && line.includes("reason=session_compact"));
	if (!rebuildLine) throw new Error("no rebuild with reason=session_compact after the compaction");
	const sessionAfter = rebuildLine.match(/sessionId=([0-9a-f]{8})/)?.[1];
	console.log(`  claude session before=${sessionBefore} after=${sessionAfter}`);
	if (!sessionBefore || !sessionAfter || sessionBefore === sessionAfter) {
		throw new Error(`the Claude session id did not change across the compaction: before=${sessionBefore} after=${sessionAfter}`);
	}
	const answer = (last?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(" ");
	console.log(`  final answer: ${answer.slice(0, 200)}`);
	if (!/\b780\b/.test(answer.replace(/,/g, ""))) {
		throw new Error(`final answer does not report the tool output's 780 lines, so the tool result did not survive the restart: ${answer.slice(0, 200)}`);
	}
	console.log("PASS");
} catch (error) {
	failed = true;
	console.log(`FAIL: ${error.message}`);
}
process.exit(failed ? 1 : 0);
