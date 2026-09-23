import { type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createSession, deleteSession, getSessionPath, normalizeProjectPath, openSession, repairToolPairing, type JsonlRecord } from "cc-session-io";
import { createHash, randomUUID } from "crypto";
import { appendFileSync, readFileSync, realpathSync, statSync } from "fs";
import { resolve as pathResolve } from "path";
import { extensionApi, piUI, reportSyntheticToolResultRepair, setSharedSession, sharedSession, type SessionState, type SyncAudit } from "./bridge-state.js";
import { convertPiMessages, sanitizeToolId } from "./convert.js";
import { withoutSystemMessages } from "./transcript-context.js";
import { DEBUG, DEBUG_LOG_PATH, debug, diagDump } from "./debug.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import {
	findUnpairedToolUses,
	insertLostToolResultPlaceholders,
	recoverLaterToolResults,
} from "./tool-pairing-audit.js";

// --- Session persistence ---

const BRIDGE_SESSION_CUSTOM_TYPE = "claude-bridge-session";

interface PersistedBridgeSessionState extends SessionState {
	fingerprint: string;
	piSessionId?: string;
	updatedAt: string;
}

function fingerprintMessages(messages: Context["messages"]): string {
	const normalized = messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: message.role,
				provider: (message as AssistantMessage).provider,
				model: (message as AssistantMessage).model,
				content: (message as AssistantMessage).content,
			};
		}
		return message;
	});
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function readBuiltSessionContext(sessionManager: unknown): { messages: Context["messages"] } | undefined {
	const built = typeof (sessionManager as any)?.buildSessionContext === "function" ? (sessionManager as any).buildSessionContext() : undefined;
	// Pi 0.86+ persists prompt/tool system messages in the session; cursors and
	// fingerprints are numbered over the provider's list, which excludes them.
	return Array.isArray(built?.messages) ? { messages: withoutSystemMessages(built.messages as Context["messages"]) } : undefined;
}

function latestPersistedBridgeSession(sessionManager: unknown): PersistedBridgeSessionState | undefined {
	const entries = typeof (sessionManager as any)?.getEntries === "function" ? (sessionManager as any).getEntries() : [];
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== BRIDGE_SESSION_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<PersistedBridgeSessionState> | undefined;
		if (!data || typeof data.sessionId !== "string" || typeof data.cursor !== "number" || typeof data.cwd !== "string" || typeof data.fingerprint !== "string") continue;
		return data as PersistedBridgeSessionState;
	}
	return undefined;
}

const PROMPT_SNAPSHOT_ATTACHMENT = "prompt_snapshot";

export type RawSessionRecord = Record<string, any>;

/** Every parsed record of a CLI session jsonl, in file order. Undefined when the file is unreadable. */
export function readSessionRecords(jsonlPath: string): RawSessionRecord[] | undefined {
	let text: string;
	try { text = readFileSync(jsonlPath, "utf8"); } catch { return undefined; }
	const records: RawSessionRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { records.push(JSON.parse(line)); } catch { /* skip malformed line */ }
	}
	return records;
}

/** The CLI's recorded system prompt: the LAST `prompt_snapshot` attachment, as the CLI itself resolves it. */
export function lastPromptSnapshot(records: RawSessionRecord[]): Record<string, unknown> | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record?.type === "attachment" && record.attachment?.type === PROMPT_SNAPSHOT_ATTACHMENT) return record.attachment as Record<string, unknown>;
	}
	return undefined;
}

export function readPromptSnapshotRecord(jsonlPath: string): Record<string, unknown> | undefined {
	const records = readSessionRecords(jsonlPath);
	return records ? lastPromptSnapshot(records) : undefined;
}

const BRIDGE_APPEND_MARKERS = ["# CLAUDE.md", "# Project memory", "The following skills provide specialized instructions"];

/** The bridge's append block as frozen in a recorded prompt snapshot, or undefined when none is recognizable. */
export function recordedAppendBlock(snapshot: Record<string, unknown> | undefined): string | undefined {
	const blocks = snapshot?.systemPrompt;
	if (!Array.isArray(blocks)) return undefined;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (typeof block === "string" && BRIDGE_APPEND_MARKERS.some((marker) => block.includes(marker))) return block;
	}
	return undefined;
}

export function appendDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

// Digest of the append block frozen in each session file's recorded snapshot,
// read once per process per file: the block only changes when this bridge
// rewrites the file (full rebuild), which invalidates the entry below.
const recordedAppendDigests = new Map<string, string | null>();

/**
 * The system-prompt append is frozen in the CLI's recorded snapshot for the
 * lifetime of a Claude session. The snapshot is the FIRST thing in every API
 * request after the tool declarations, so rewriting it (as this bridge did
 * until 2026-09-22 whenever AGENTS.md or a skill changed) invalidated the
 * prompt cache for the entire conversation: every AGENTS.md commit in a
 * repository cost a 100-500k re-write on the next turn of every Claude session
 * in that repository. The CLI itself never rewrites the snapshot; it delivers
 * environment changes as an appended message. This does the same: when the
 * current append differs from the recorded block and has not been delivered
 * yet, it is returned so the caller can prepend it to the user prompt, where it
 * costs only its own tokens.
 */
export function pendingAppendUpdate(
	jsonlPath: string,
	appendText: string | undefined,
	deliveredDigest: string | undefined,
): { text: string; digest: string } | undefined {
	if (!appendText) return undefined;
	let recorded = recordedAppendDigests.get(jsonlPath);
	if (recorded === undefined) {
		const records = readSessionRecords(jsonlPath);
		const block = records ? recordedAppendBlock(lastPromptSnapshot(records)) : undefined;
		recorded = block === undefined ? null : appendDigest(block);
		recordedAppendDigests.set(jsonlPath, recorded);
	}
	if (recorded === null) return undefined;
	const digest = appendDigest(appendText);
	if (digest === recorded || digest === deliveredDigest) return undefined;
	debug(`pendingAppendUpdate: AGENTS.md, project memory, or skills changed since the recorded prompt; delivering the update in the prompt instead of rewriting the snapshot`);
	return { text: appendText, digest };
}

/**
 * The CLI replays a recorded prompt verbatim, which also freezes the block
 * this bridge appends (AGENTS.md + pi's skills list). Before the snapshot,
 * every launch re-read AGENTS.md, so an edit applied on the next turn. Keep
 * that: when the current append text differs from the recorded block, return
 * a copy of the snapshot with the block replaced. The rest of the record
 * (the CLI's own sections, tool descriptions) is untouched. Returns undefined
 * when nothing needs to change or the block cannot be identified.
 */
export function refreshSnapshotAppend(
	snapshot: Record<string, unknown>,
	appendText: string | undefined,
): Record<string, unknown> | undefined {
	const blocks = snapshot.systemPrompt;
	if (!Array.isArray(blocks) || !appendText) return undefined;
	let index = -1;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (typeof block !== "string") continue;
		if (BRIDGE_APPEND_MARKERS.some((marker) => block.includes(marker))) { index = i; break; }
	}
	if (index < 0) return undefined;
	if (blocks[index] === appendText) return undefined;
	const next = [...blocks];
	next[index] = appendText;
	return { ...snapshot, systemPrompt: next };
}

// One read per process per (session, append text): the jsonl can be tens of
// megabytes, and the append only changes when AGENTS.md or a skill does.
const ensuredAppend = new Map<string, string>();

/** Make sure the session's recorded prompt carries the current bridge append; appends a refreshed record when it does not. */
/**
 * The audit of a clean start cannot be attached to `sharedSession` (there is
 * none yet); the provider picks it up when the CLI reports the new session id.
 */
export let pendingCleanStartAudit: SyncAudit | undefined;
export function takePendingCleanStartAudit(): SyncAudit | undefined {
	const audit = pendingCleanStartAudit;
	pendingCleanStartAudit = undefined;
	return audit;
}

function syncAudit(
	path: SyncAudit["path"],
	detail: Omit<SyncAudit, "path" | "at" | "tools" | "appendDigest">,
	customToolNameToSdk: Map<string, string> | undefined,
	systemPromptAppend: string | undefined,
): SyncAudit {
	// The map holds the exact name and its lowercase alias for every tool.
	const tools = customToolNameToSdk ? new Set(customToolNameToSdk.values()).size : undefined;
	return {
		path,
		...detail,
		...(tools !== undefined ? { tools } : {}),
		...(systemPromptAppend ? { appendDigest: createHash("sha256").update(systemPromptAppend).digest("hex").slice(0, 12) } : {}),
		at: new Date().toISOString(),
	};
}

export function ensurePromptSnapshotAppend(jsonlPath: string, sessionId: string, appendText: string | undefined): void {
	if (!appendText) return;
	const key = `${jsonlPath}`;
	const digest = createHash("sha256").update(appendText).digest("hex");
	if (ensuredAppend.get(key) === digest) return;
	const records = readSessionRecords(jsonlPath);
	if (!records) return;
	const snapshot = lastPromptSnapshot(records);
	if (!snapshot) { ensuredAppend.set(key, digest); return; }
	const refreshed = refreshSnapshotAppend(snapshot, appendText);
	if (refreshed) {
		const ok = appendPromptSnapshotRecord(jsonlPath, sessionId, refreshed);
		debug(`ensurePromptSnapshotAppend: ${ok ? "refreshed" : "FAILED to refresh"} the recorded append block for ${sessionId.slice(0, 8)} (AGENTS.md or skills changed)`);
		if (!ok) return;
	}
	ensuredAppend.set(key, digest);
}

/**
 * After a rebuild that carried native records, prove the uuid chain is intact
 * before the CLI reads it: every chained record's parent must appear earlier
 * in the file, and the first converted record must parent to the last carried
 * message. A broken chain makes the CLI resume with an empty conversation.
 */
export function verifyRecordChain(jsonlPath: string): string | undefined {
	const records = readSessionRecords(jsonlPath);
	if (!records) return "unreadable";
	const seen = new Set<string>();
	let chained = 0;
	for (const record of records) {
		if (record.type !== "user" && record.type !== "assistant" && record.type !== "attachment") continue;
		// Subagent sidechains have their own roots by design.
		if (record.isSidechain === true) continue;
		if (typeof record.uuid !== "string") return `record without uuid (${record.type})`;
		const parent = record.parentUuid;
		if (parent != null) {
			if (!seen.has(parent)) return `dangling parent ${String(parent).slice(0, 8)} on ${record.type} ${record.uuid.slice(0, 8)}`;
		} else if (chained > 0) {
			return `second chain root at ${record.type} ${record.uuid.slice(0, 8)}`;
		}
		seen.add(record.uuid);
		chained++;
	}
	return undefined;
}

function recordText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function toolResultIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b) => b && b.type === "tool_result" && typeof b.tool_use_id === "string").map((b) => b.tool_use_id as string);
}

function sameSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const set = new Set(left);
	return right.every((id) => set.has(id));
}

/**
 * How much of the CLI's own transcript can be reused verbatim for a rebuild.
 *
 * A rebuild re-serializes pi history, but the CLI's native records also carry
 * things pi never sees (`total_tokens_reminder` and other attachments, the
 * exact tool_result shapes), so a rebuilt prefix differs from what the API
 * cached and every token after the first difference is written again. Walking
 * the native records against pi's messages finds the longest leading run that
 * is provably the same conversation; those records are carried over unchanged
 * and only the rest is converted. Cuts happen only right before a pi user
 * message, so a carried prefix never ends with an unpaired tool_use.
 *
 * Returns the number of native records to carry and the number of leading pi
 * messages they cover. `{ 0, 0 }` means convert everything as before.
 */
export function alignNativePrefix(
	records: RawSessionRecord[],
	messages: Context["messages"],
): { recordCount: number; messageCount: number } {
	let best = { recordCount: 0, messageCount: 0 };
	const ids = new Map<string, string>();
	let r = 0;
	let openToolCalls = false;
	const nextMessageRecord = (): number => {
		while (r < records.length && records[r]?.type !== "user" && records[r]?.type !== "assistant") r++;
		return r;
	};
	for (let p = 0; p < messages.length; p++) {
		const msg = messages[p] as any;
		if (msg.role === "user") {
			nextMessageRecord();
			const rec = records[r];
			if (!rec || rec.type !== "user" || toolResultIds(rec.message?.content).length > 0) break;
			const piText = recordText(msg.content).trim();
			const ccText = recordText(rec.message?.content);
			if (piText.length === 0 || !ccText.includes(piText)) break;
			r++;
		} else if (msg.role === "assistant") {
			nextMessageRecord();
			const first = records[r];
			if (!first || first.type !== "assistant") break;
			const messageId = first.message?.id;
			const toolUses: string[] = [];
			let consumed = 0;
			while (r < records.length) {
				const rec = records[r];
				if (rec.type !== "assistant") break;
				if (consumed > 0 && (!messageId || rec.message?.id !== messageId)) break;
				for (const block of Array.isArray(rec.message?.content) ? rec.message.content : []) {
					if (block?.type === "tool_use" && typeof block.id === "string") toolUses.push(block.id);
				}
				consumed++;
				r++;
			}
			const piCalls = (Array.isArray(msg.content) ? msg.content : [])
				.filter((b: any) => b?.type === "toolCall" && typeof b.id === "string")
				.map((b: any) => sanitizeToolId(b.id, ids));
			if (!sameSet(piCalls, toolUses)) break;
			openToolCalls = piCalls.length > 0;
		} else if (msg.role === "toolResult") {
			const pending = new Set<string>();
			let q = p;
			for (; q < messages.length && (messages[q] as any).role === "toolResult"; q++) {
				pending.add(sanitizeToolId((messages[q] as any).toolCallId, ids));
			}
			let ok = true;
			while (pending.size > 0) {
				nextMessageRecord();
				const rec = records[r];
				const found = rec && rec.type === "user" ? toolResultIds(rec.message?.content) : [];
				if (found.length === 0 || !found.every((id) => pending.has(id))) { ok = false; break; }
				for (const id of found) pending.delete(id);
				r++;
			}
			if (!ok) break;
			p = q - 1;
			openToolCalls = false;
		} else {
			break;
		}
		const next = messages[p + 1] as any;
		// A cut is safe only where no tool_use is still waiting for its result:
		// before the next user prompt, or at the end of history. A steer that pi
		// slipped in between a tool call and its results is a user message with
		// open calls and must not become a cut, or the carried prefix would end
		// with an unpaired tool_use the converter never sees. An aborted turn's
		// open calls are likewise left to the converter, which pairs them.
		if (msg.role !== "user" && !openToolCalls && (next === undefined || next.role === "user")) best = { recordCount: r, messageCount: p + 1 };
	}
	return best;
}

/** Append a `prompt_snapshot` attachment as the new leaf of a freshly written jsonl, chained to its last record like the CLI writes attachments. */
export function appendPromptSnapshotRecord(jsonlPath: string, sessionId: string, attachment: Record<string, unknown>): boolean {
	try {
		const text = readFileSync(jsonlPath, "utf8");
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		// Parent to the last CHAINED record. A native file almost always ends with
		// bookkeeping lines that carry no uuid (`last-prompt`, `atis-latch`,
		// `mode`: 199 of 200 files sampled 2026-09-17); parenting to those would
		// make the attachment a second chain root and the CLI could resume with
		// an empty conversation.
		let parentUuid: string | null = null;
		for (let i = lines.length - 1; i >= 0; i--) {
			let candidate: { type?: string; uuid?: string; isSidechain?: boolean };
			try { candidate = JSON.parse(lines[i]); } catch { continue; }
			if ((candidate.type === "user" || candidate.type === "assistant" || candidate.type === "attachment") && typeof candidate.uuid === "string" && !candidate.isSidechain) {
				parentUuid = candidate.uuid;
				break;
			}
		}
		if (parentUuid === null && lines.length > 0) {
			debug("appendPromptSnapshotRecord: no chained record to parent to; skipping");
			return false;
		}
		const record = {
			parentUuid,
			isSidechain: false,
			attachment,
			type: "attachment",
			uuid: randomUUID(),
			timestamp: new Date().toISOString(),
			sessionId,
		};
		appendFileSync(jsonlPath, `${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${JSON.stringify(record)}\n`, "utf8");
		return true;
	} catch (error) {
		debug("appendPromptSnapshotRecord failed:", error);
		return false;
	}
}

function claudeSessionExists(sessionId: string, cwd: string, claudeConfigDir?: string): boolean {
	try {
		const session = openSession({ sessionId, projectPath: cwd, claudeDir: claudeConfigDir });
		statSync(session.jsonlPath);
		return true;
	} catch {
		return false;
	}
}

function canonicalize(p: string | undefined): string | undefined {
	if (!p) return undefined;
	try { return realpathSync.native(p); } catch { return pathResolve(p); }
}

// Decides whether a persisted bridge-session marker is safe to restore.
//
// The fork case is the load-bearing one: pi/core's createBranchedSession copies
// every non-label entry from root→leaf into the new session file. That includes
// our claude-bridge-session markers from the parent. Restoring from them would
// --resume parent's Claude jsonl on the fork's first turn, leaking conversation
// past the fork point.
//
// Returns undefined when the entry is safe to use, or a short rejection reason
// for diagnostic logging. Old entries without piSessionId always reject, which
// degrades safely to the rebuild path.
export function shouldRestorePersistedBridgeEntry(
	persisted: { piSessionId?: string; cwd: string },
	currentPiSessionId: string | undefined,
	currentCwd: string | undefined,
): string | undefined {
	if (!persisted.piSessionId) return "missing piSessionId";
	if (currentPiSessionId && persisted.piSessionId !== currentPiSessionId) {
		return `piSessionId mismatch (persisted=${persisted.piSessionId} current=${currentPiSessionId})`;
	}
	if (currentCwd && canonicalize(persisted.cwd) !== canonicalize(currentCwd)) {
		return `cwd mismatch (persisted=${persisted.cwd} current=${currentCwd})`;
	}
	return undefined;
}

export function restoreSharedSessionFromPi(ctx: { sessionManager?: unknown; cwd?: string }): void {
	const persisted = latestPersistedBridgeSession(ctx.sessionManager);
	if (!persisted) return;
	const currentPiSessionId = typeof (ctx.sessionManager as any)?.getSessionId === "function" ? (ctx.sessionManager as any).getSessionId() : undefined;
	const currentCwd = typeof (ctx.sessionManager as any)?.getCwd === "function" ? (ctx.sessionManager as any).getCwd() : ctx.cwd;
	const rejection = shouldRestorePersistedBridgeEntry(persisted, currentPiSessionId, currentCwd);
	if (rejection) {
		debug(`restoreSharedSession: ${rejection} — forcing rebuild`);
		return;
	}
	const built = readBuiltSessionContext(ctx.sessionManager);
	if (!built) return;
	const cursor = Math.max(0, Math.min(persisted.cursor, built.messages.length));
	const fingerprint = fingerprintMessages(built.messages.slice(0, cursor));
	if (fingerprint !== persisted.fingerprint) {
		debug(`restoreSharedSession: fingerprint mismatch for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	if (!claudeSessionExists(persisted.sessionId, persisted.cwd, persisted.claudeConfigDir)) {
		debug(`restoreSharedSession: Claude session missing for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	setSharedSession({
		sessionId: persisted.sessionId,
		cursor,
		cwd: persisted.cwd,
		...(persisted.accountProfileId ? { accountProfileId: persisted.accountProfileId } : {}),
		...(persisted.claudeConfigDir ? { claudeConfigDir: persisted.claudeConfigDir } : {}),
	});
	debug(`restoreSharedSession: restored ${persisted.sessionId.slice(0, 8)}, cursor=${cursor}`);
}

const scheduledPersistenceTimers = new Set<ReturnType<typeof setTimeout>>();

export function cancelScheduledSessionPersistence(): void {
	for (const timer of scheduledPersistenceTimers) clearTimeout(timer);
	scheduledPersistenceTimers.clear();
}

export function schedulePersistSharedSession(ctxLike?: { sessionManager?: unknown }): void {
	if (!extensionApi || !sharedSession || !ctxLike?.sessionManager) return;
	// Extension contexts become guarded/stale as soon as shutdown or replacement
	// starts. Capture the plain SessionManager reference now and cancel the timer
	// on shutdown rather than dereferencing the ctx proxy from the next tick.
	const sessionManager = ctxLike.sessionManager;
	const snapshot = { ...sharedSession };
	const timer = setTimeout(() => {
		scheduledPersistenceTimers.delete(timer);
		try {
			const built = readBuiltSessionContext(sessionManager);
			if (!built) return;
			const cursor = Math.max(0, Math.min(snapshot.cursor, built.messages.length));
			const data: PersistedBridgeSessionState = {
				...snapshot,
				cursor,
				fingerprint: fingerprintMessages(built.messages.slice(0, cursor)),
				piSessionId: typeof (sessionManager as any)?.getSessionId === "function" ? (sessionManager as any).getSessionId() : undefined,
				updatedAt: new Date().toISOString(),
			};
			extensionApi?.appendEntry(BRIDGE_SESSION_CUSTOM_TYPE, data);
			debug(`persistSharedSession: saved ${data.sessionId.slice(0, 8)}, cursor=${data.cursor}`);
		} catch (error) {
			debug("persistSharedSession failed:", error);
		}
	}, 0);
	scheduledPersistenceTimers.add(timer);
	timer.unref?.();
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature). User and
// tool-result image blocks are preserved when possible. If assistant blocks are
// otherwise incompatible, convertPiMessages emits a text placeholder so the record
// sequence stays valid before repairToolPairing runs.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	cwd?: string,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// A steer can make Pi split one parallel Claude batch across several visible
	// assistant/tool-result pairs. Recover those real later results before the
	// generic repair layer mistakes them for lost output.
	const recoveredToolResults = recoverLaterToolResults(anthropicMessages);
	if (recoveredToolResults.length > 0) {
		debug(
			`convertAndImportMessages: recovered ${recoveredToolResults.length} later tool result(s) for original parallel batch`,
			recoveredToolResults.map((item) => item.id).join(", "),
		);
	}
	// Pair every remaining orphaned tool_use with an explicit bridge-authored
	// error result before cc-session-io can insert a bare placeholder.
	const missingToolResults = findUnpairedToolUses(anthropicMessages);
	if (missingToolResults.length > 0) insertLostToolResultPlaceholders(anthropicMessages, missingToolResults);
	const repaired = repairToolPairing(anthropicMessages);
	if (missingToolResults.length > 0) {
		reportSyntheticToolResultRepair(missingToolResults, {
			cwd,
			messageCount: messages.length,
			anthropicMessageCount: anthropicMessages.length,
			sessionId: session.sessionId,
			jsonlPath: session.jsonlPath,
		});
	}
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

interface SyncResult {
	sessionId: string | null;
	/** Current system-prompt append to deliver in this turn's prompt, because it differs from the recorded snapshot (see pendingAppendUpdate). */
	appendUpdate?: { text: string; digest: string };
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
	claudeConfigDir?: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${claudeConfigDir ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: claudeConfigDir ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string, claudeConfigDir?: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: selected.CLAUDE_CONFIG_DIR=${claudeConfigDir ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
export function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	account?: { accountProfileId?: string; claudeConfigDir?: string },
	/** How many trailing messages the caller sends as the prompt instead of
	 *  importing. 1 for a normal turn (the new user message). 0 for a
	 *  continuation after auto-compaction/auto-retry, where the tail is a tool
	 *  result that MUST stay in the imported history: dropping it would leave
	 *  its tool_use unpaired and the repair layer would replace a real result
	 *  with a synthetic error. */
	dropTrailing = 1,
	/** The bridge's current system-prompt append (AGENTS.md + skills), so a recorded prompt can be kept in sync with edits. */
	systemPromptAppend?: string,
): SyncResult {
	const priorMessages = messages.slice(0, messages.length - dropTrailing);
	const accountProfileId = account?.accountProfileId;
	const claudeConfigDir = account?.claudeConfigDir;
	const sameAccount = Boolean(
		sharedSession &&
		sharedSession.accountProfileId === accountProfileId &&
		sharedSession.claudeConfigDir === claudeConfigDir,
	);

	// REUSE path. A Claude session can only be resumed under the credential
	// profile that created its JSONL and prompt cache.
	if (sharedSession && sameAccount && !sharedSession.needsRebuild) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			const appendUpdate = pendingAppendUpdate(
				getSessionPath(sharedSession.sessionId, normalizeProjectPath(cwd), claudeConfigDir),
				systemPromptAppend,
				sharedSession.deliveredAppendDigest,
			);
			setSharedSession({
				...sharedSession,
				...(trailingAssistantOnly ? { cursor: priorMessages.length, cwd } : {}),
				lastSync: syncAudit("reuse", { priors: priorMessages.length, ...(appendUpdate ? { appendDelivered: true } : {}) }, customToolNameToSdk, systemPromptAppend),
			});
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor} account=${accountProfileId ?? "default"}`);
			return { sessionId: sharedSession.sessionId, ...(appendUpdate ? { appendUpdate } : {}) };
		}
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages, account=${accountProfileId ?? "default"}`);
		debug(`syncResult: path=clean-start`);
		pendingCleanStartAudit = syncAudit("clean", {}, customToolNameToSdk, systemPromptAppend);
		return { sessionId: null };
	}
	const rebuildReason = sharedSession?.needsRebuild
		? sharedSession.rebuildReason ?? "marked"
		: !sharedSession
			? "first"
			: !sameAccount
				? "account-rotation"
				: "drift";
	const replacedSessionId = sharedSession?.sessionId;
	const previousSessionId = sameAccount ? sharedSession?.sessionId : undefined;
	const previousCursor = sameAccount ? sharedSession?.cursor ?? 0 : 0;
	// Preserve a UUID only within the same credential profile. Reusing an A
	// account session id under B can resume the wrong transcript or miss the file.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// The CLI records the conversation's system prompt once (systemPromptSnapshot)
	// and replays it verbatim on every resume. A rebuilt jsonl would lose that
	// record, so the next launch would render a fresh prompt (new git status,
	// re-read AGENTS.md) and miss the cache for the whole conversation. Carry
	// the record over before the old file is deleted.
	const oldRecords = sharedSession
		? readSessionRecords(getSessionPath(sharedSession.sessionId, normalizeProjectPath(sharedSession.cwd), sharedSession.claudeConfigDir))
		: undefined;
	const carriedPromptSnapshot = oldRecords ? lastPromptSnapshot(oldRecords) : undefined;
	// Reuse the CLI's own records for the part of the conversation that is
	// provably unchanged (see alignNativePrefix), so the API's cached prefix
	// survives the rebuild; only the tail is converted from pi history.
	const aligned = oldRecords && oldRecords.length > 0 ? alignNativePrefix(oldRecords, priorMessages) : { recordCount: 0, messageCount: 0 };
	const carriedRecords = aligned.messageCount > 0 ? oldRecords!.slice(0, aligned.recordCount) : [];
	if (preserveId) {
		deleteSession(previousSessionId!, cwd, claudeConfigDir);
	}
	let session = createSession({
		projectPath: cwd,
		claudeDir: claudeConfigDir,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	let coveredMessages = 0;
	if (carriedRecords.length > 0) {
		try {
			if (!("_lastUuid" in (session as object))) throw new Error("cc-session-io Session no longer exposes _lastUuid; cannot chain a converted tail after carried records");
			for (const record of carriedRecords) session.dangerousAppendRecord(record as JsonlRecord);
			// dangerousAppendRecord deliberately does not advance the uuid chain;
			// the converted tail must parent to the last carried message or the
			// CLI resumes from an empty chain.
			for (let i = carriedRecords.length - 1; i >= 0; i--) {
				const record = carriedRecords[i];
				if (record.type === "user" || record.type === "assistant" || record.type === "attachment") {
					(session as unknown as { _lastUuid: string | null })._lastUuid = record.uuid ?? null;
					break;
				}
			}
			coveredMessages = aligned.messageCount;
			debug(`Case 4: carried ${carriedRecords.length} native records covering ${coveredMessages}/${priorMessages.length} pi messages verbatim`);
		} catch (error) {
			// A record whose parent is outside the carried range would strand the
			// CLI; fall back to converting everything, as before this optimization.
			debug("Case 4: native prefix carry failed, converting the whole history:", error);
			coveredMessages = 0;
			session = createSession({
				projectPath: cwd,
				claudeDir: claudeConfigDir,
				sessionId: session.sessionId,
				...(modelId ? { model: modelId } : {}),
			});
		}
	}
	convertAndImportMessages(session, priorMessages.slice(coveredMessages), customToolNameToSdk, cwd);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd, claudeConfigDir);
	if (coveredMessages > 0) {
		const chainProblem = verifyRecordChain(session.jsonlPath);
		if (chainProblem) {
			// Never hand the CLI a file it would resume as an empty conversation:
			// rewrite it the old way, from pi history alone.
			debug(`Case 4: carried prefix failed chain verification (${chainProblem}); rewriting ${session.sessionId.slice(0, 8)} from pi history`);
			diagDump("native_prefix_carry_rejected", { reason: chainProblem, carried: carriedRecords.length, covered: coveredMessages, sessionId: session.sessionId });
			deleteSession(session.sessionId, cwd, claudeConfigDir);
			session = createSession({ projectPath: cwd, claudeDir: claudeConfigDir, sessionId: session.sessionId, ...(modelId ? { model: modelId } : {}) });
			convertAndImportMessages(session, priorMessages, customToolNameToSdk, cwd);
			session.save();
			verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd, claudeConfigDir);
			coveredMessages = 0;
		}
	}
	const carriedIncludesSnapshot = coveredMessages > 0 && Boolean(lastPromptSnapshot(carriedRecords));
	if (carriedPromptSnapshot && !carriedIncludesSnapshot) {
		const carried = appendPromptSnapshotRecord(session.jsonlPath, session.sessionId, carriedPromptSnapshot);
		debug(`Case 4: ${carried ? "carried" : "FAILED to carry"} the CLI prompt_snapshot record into rebuilt session ${session.sessionId.slice(0, 8)}`);
	}
	ensuredAppend.delete(session.jsonlPath);
	recordedAppendDigests.delete(session.jsonlPath);
	// A rebuild that carried native records still has a chance at the cached
	// prefix, so its snapshot is left as recorded and an append change is
	// delivered in the prompt like the reuse path. A full rewrite has already
	// lost the cache, so the recorded snapshot is simply brought up to date.
	const carriedPrefix = coveredMessages > 0;
	let appendUpdate: SyncResult["appendUpdate"];
	if (carriedPrefix) {
		appendUpdate = pendingAppendUpdate(session.jsonlPath, systemPromptAppend, sameAccount ? sharedSession?.deliveredAppendDigest : undefined);
	} else {
		ensurePromptSnapshotAppend(session.jsonlPath, session.sessionId, systemPromptAppend);
	}
	setSharedSession({
		sessionId: session.sessionId,
		cursor: priorMessages.length,
		cwd,
		...(accountProfileId ? { accountProfileId } : {}),
		...(claudeConfigDir ? { claudeConfigDir } : {}),
		...(carriedPrefix && sameAccount && sharedSession?.deliveredAppendDigest ? { deliveredAppendDigest: sharedSession.deliveredAppendDigest } : {}),
		lastSync: syncAudit("rebuild", {
			reason: rebuildReason,
			priors: priorMessages.length,
			missed: Math.max(0, priorMessages.length - previousCursor),
			carried: coveredMessages > 0 ? carriedRecords.length : 0,
			covered: coveredMessages,
			rotated: !preserveId,
			...(appendUpdate ? { appendDelivered: true } : {}),
		}, customToolNameToSdk, systemPromptAppend),
	});
	if (!replacedSessionId) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (!sameAccount) {
		debug(`Case 4 account-rotation: ${priorMessages.length} prior messages → new session ${session.sessionId.slice(0, 8)} for account ${accountProfileId ?? "default"} (replaced ${replacedSessionId.slice(0, 8)})`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId!.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath, claudeConfigDir);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} account=${accountProfileId ?? "default"} ${!replacedSessionId ? "first" : preserveId ? "preserved" : "rotated"} reason=${rebuildReason}`);
	return { sessionId: session.sessionId, ...(appendUpdate ? { appendUpdate } : {}) };
}
