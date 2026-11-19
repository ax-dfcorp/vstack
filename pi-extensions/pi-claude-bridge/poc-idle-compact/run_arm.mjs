#!/usr/bin/env node
// One PoC arm: open a disposable session copy in Pi RPC mode with a bridge
// package copy, send the prompts in order, and record what happened.
//
// usage: node run_arm.mjs <case dir> <arm: full|compact> <bridge package dir> <prompts.json> [--steer-during-compaction "<text>"]
//
// The case dir holds session.jsonl (from make_case.py). The arm works on its
// own copy <case>/<arm>/session.jsonl in cwd <case>/<arm>/. Output:
// <case>/<arm>/result.json with every assistant message's usage, compaction
// events, timings, and the final text of each prompt.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [caseArg, arm, bridgeArg, promptsArg, ...rest] = process.argv.slice(2);
const caseDir = resolve(caseArg), bridgeDir = resolve(bridgeArg), promptsPath = resolve(promptsArg);
const steerIdx = rest.indexOf("--steer-during-compaction");
const steerText = steerIdx >= 0 ? rest[steerIdx + 1] : undefined;
const prompts = JSON.parse(readFileSync(promptsPath, "utf8"));
const armDir = join(caseDir, arm);
mkdirSync(armDir, { recursive: true });
const sessionPath = join(armDir, "session.jsonl");
copyFileSync(join(caseDir, "session.jsonl"), sessionPath);

const env = {
	...process.env,
	CLAUDE_CONFIG_DIR: process.env.POC_CLAUDE_CONFIG_DIR,
	CLAUDE_BRIDGE_IDLE_COMPACT: arm.startsWith("compact") ? "1" : "0",
	CLAUDE_BRIDGE_DEBUG: "1",
	CLAUDE_BRIDGE_DEBUG_PATH: join(armDir, "bridge-debug.log"),
	CLAUDE_BRIDGE_DIAG_PATH: join(armDir, "bridge-diag.log"),
};
const args = ["-ne", "-e", bridgeDir, "-e", "/Users/ddgk/ws/pi-local/extensions/compaction-anchor.ts", "--tools", "read", "--session", sessionPath, "--mode", "rpc"];
const pi = spawn("pi", args, { cwd: armDir, env, stdio: ["pipe", "pipe", "pipe"] });
const log = [];
let buffer = "";
const listeners = [];
pi.stderr.on("data", (d) => log.push({ stderr: d.toString().slice(0, 2000) }));
let piExited;
const exited = new Promise((resolve) => pi.on("exit", (code, signal) => { piExited = { code, signal }; resolve(); }));
pi.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		msg.__t = Date.now();
		for (const l of [...listeners]) l(msg);
	}
});
let id = 0;
function send(cmd) {
	const reqId = String(++id);
	pi.stdin.write(JSON.stringify({ ...cmd, id: reqId }) + "\n");
	return new Promise((resolve) => {
		const l = (msg) => {
			if (msg.type === "response" && msg.id === reqId) {
				listeners.splice(listeners.indexOf(l), 1);
				resolve(msg);
			}
		};
		listeners.push(l);
	});
}
const events = [];
listeners.push((msg) => {
	if (["compaction_start", "compaction_end", "agent_start", "agent_end", "message_end", "message_start"].includes(msg.type)) {
		const m = msg.message;
		events.push({
			t: msg.__t,
			type: msg.type,
			...(msg.reason ? { reason: msg.reason } : {}),
			...(msg.type === "compaction_end" ? { aborted: msg.aborted, errorMessage: msg.errorMessage, tokensBefore: msg.result?.tokensBefore, estimatedTokensAfter: msg.result?.estimatedTokensAfter, usage: msg.result?.usage, summaryChars: msg.result?.summary?.length } : {}),
			...(m ? { role: m.role, model: m.model, usage: m.usage, stopReason: m.stopReason, errorMessage: m.errorMessage, text: m.role === "assistant" ? (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") : undefined, toolCalls: m.role === "assistant" ? (m.content ?? []).filter((b) => b.type === "toolCall").map((b) => b.name) : undefined } : {}),
		});
	}
});
function waitFor(pred, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { listeners.splice(listeners.indexOf(l), 1); reject(new Error("timeout")); }, ms);
		const l = (msg) => { if (pred(msg)) { clearTimeout(timer); listeners.splice(listeners.indexOf(l), 1); resolve(msg); } };
		listeners.push(l);
	});
}

const result = { arm, caseDir, prompts: [], startedAt: new Date().toISOString() };
try {
	await new Promise((r) => setTimeout(r, 3000));
	for (const [n, text] of prompts.entries()) {
		const t0 = Date.now();
		const settled = waitFor((m) => m.type === "agent_end", 20 * 60_000);
		const response = send({ type: "prompt", message: text });
		let steer;
		if (steerText && n === 0) {
			await waitFor((m) => m.type === "compaction_start", 120_000).catch(() => undefined);
			await new Promise((r) => setTimeout(r, 2000));
			steer = await send({ type: "prompt", message: steerText, streamingBehavior: "steer" });
		}
		const ack = await Promise.race([response, exited.then(() => { throw new Error(`pi exited ${JSON.stringify(piExited)}`); })]);
		await Promise.race([settled, exited.then(() => { throw new Error(`pi exited ${JSON.stringify(piExited)}`); })]);
		result.prompts.push({ n, ack: { success: ack.success, error: ack.error, data: ack.data }, ...(steer ? { steerAck: { success: steer.success, error: steer.error, data: steer.data } } : {}), ms: Date.now() - t0, ackMs: ack.__t - t0 });
		await new Promise((r) => setTimeout(r, 1500));
	}
} catch (error) {
	result.error = String(error);
} finally {
	result.events = events;
	result.endedAt = new Date().toISOString();
	writeFileSync(join(armDir, "result.json"), JSON.stringify(result, null, 1));
	pi.stdin.end();
	setTimeout(() => pi.kill("SIGTERM"), 3000);
	writeFileSync(join(armDir, "stderr.log"), log.map((l) => l.stderr).join(""));
}
