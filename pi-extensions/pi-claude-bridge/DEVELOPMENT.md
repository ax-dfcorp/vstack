# pi-claude-bridge — development notes

Implementation details for contributors. End-user setup, settings, and troubleshooting live in [`README.md`](./README.md).

## Stream and tool-result handling

- The bridge runs Claude Code through the Claude Agent SDK while Pi remains the owner of the visible TUI and tool execution.
- A tool-use turn ends at the stream's `message_stop`, not at the first early signal. The SDK yields the completed assistant message AND invokes the MCP tool handlers before `message_delta` arrives — and `message_delta` is what carries the message's real output-token count, so ending the pi stream at either early signal froze pi's per-turn output figures at the `message_start` placeholders (1–7 tokens; 2026-07-28 token test). The early signals now only arm a ~1.5s grace timer (`scheduleToolUseTurnEnd`) that force-finalizes the turn if the terminal events never arrive (the pi 0.80 steer-draining case), so the MCP handlers can never deadlock waiting on a stream pi will not end.
- The grace timer measures **silence**, not elapsed time. Both early signals fire as soon as the FIRST tool_use block of a message completes (the SDK yields a per-block partial copy of the assistant message), while a model that issued several calls in one message is still streaming the later blocks. A fixed timer cut those blocks off: pi received the later calls with `{}` arguments (rejected by validation) or not at all, and a handler for a call pi never received waited forever (2026-09-02, Fable 5.1, 47 minutes until a manual abort). The timer now re-arms on every real stream event. An open block can be force-sealed only from syntactically complete JSON or the MCP handler's schema-validated arguments (`tool_use_turn_forced_with_open_blocks`); incomplete blocks wait for the progress watchdog (with an independent 90s safe-drop backstop even when that watchdog is disabled), and a terminal boundary drops them as undeliverable (`incomplete_tool_calls_dropped`) instead of executing partial input or mapper defaults. Transport ping frames do not count as watchdog progress.
- A tool call pi never received fails fast. `endToolUseTurn` records every toolCall block of the delivered message (`deliveredToPiToolCallIds`); a tool_use recorded after its pi turn already ended is flagged undeliverable (`tool_use_after_pi_turn_end`). An MCP handler claiming such a call, or still waiting after pi delivered the turn's results, gets an explicit `is_error` result (`undelivered_tool_call_failed_fast`) telling the model to re-issue the call, instead of blocking the child until a manual abort.
- **Steering reaches a running turn.** The query's prompt is a channel (`src/input-channel.ts`) held open for the query's lifetime, not a string. A string prompt sets the SDK's `isSingleUserTurn`, which closes the child's stdin at the first `result` and makes mid-run input impossible; with the channel open, a steer written while an MCP handler is still waiting is coalesced by the CLI into its next model turn — the boundary pi's native providers drain steering at, and the one codex reads its pending-input queue at. The write happens BEFORE this turn's tool results are resolved (`canInjectSteer`): after they resolve the child may already be sampling. A waiting handler is required because it proves another model turn exists to consume the message; without one the steer falls back to the existing after-the-run replay, the same shape as codex rejecting a steer that lost the race and re-queueing it. The cost of holding input open is that the query no longer ends by itself — `consumeQuery` closing the channel at `result` is what ends it, with teardown as the backstop for paths that never see one.
- **A tool-result tail with no active query is usually pi continuing, not an orphan.** pi runs `for (await agent.prompt(); await handlePostAgentRun(); ) await agent.continue()`, and both overflow auto-compaction and auto-retry strip the failed assistant message before continuing — so the continuation re-enters the provider with a tool result at the tail, looking exactly like the result an aborted turn left behind. Answering it with an empty end_turn ended the run silently (five occurrences in one local history, each right after a mid-task compaction and each followed by the user retyping the prompt). `isTurnContinuation` decides from the cause recorded at teardown instead: only an abort makes the tail meaningless. A continuation keeps that tail in the imported history (`syncSharedSession(..., dropTrailing: 0)`) so every tool_use keeps its real result rather than a synthetic "lost output" placeholder, and `CONTINUATION_PROMPT` restarts sampling. Codex never hits this because it compacts inline inside its turn loop (`CompactionPhase::MidTurn`, then `continue`); opencode re-derives "is there more to do" from history each iteration and marks abort-abandoned tool parts explicitly.
- Pi acknowledges an abort just before the provider's SDK consumer finishes teardown. A user prompt arriving in that narrow window waits on the captured query's settlement promise and then starts as a fresh query; treating it as tool-result delivery to the dying query emitted an empty aborted turn and silently lost the prompt. The real RPC integration test covers abort-during-tool followed immediately by a recovery prompt.
- An MCP handler claims its tool-call id by tool name + arguments; when no exact match exists but exactly ONE unclaimed call of that tool type does, it is claimed anyway (`argsMismatch` diag) — the handler receives the schema-VALIDATED input while the record holds the raw streamed input, and a stripped key must not strand the call. Nested schema objects also validate permissively (`.passthrough()`) unless the schema says `additionalProperties: false`, matching JSON Schema's default.
- Tool results whose IDs were never registered in the active assistant tool-use turn are refused instead of being queued against another pending call. Remaining handlers receive an internal-error result so the turn cannot report false success.
- Queued results that can no longer be consumed (their handler already gave up) are reaped at the next child message boundary with a `stale_queued_tool_results_dropped` diagnostic, instead of poisoning every later mismatch report for the query.
- If a query tears down while parallel tool results are still queued or unresolved, the bridge writes diagnostics, marks the Claude session for rebuild, and re-imports delivered results from Pi history on the next turn.
- Integrity events (mismatch, synthetic-result repair, stale-result reap, unmatched handler, forced end with safe open blocks, incomplete-call drop, late tool_use, undelivered-call fail-fast) are also appended to the pi session as `claude-bridge-integrity` custom entries — compact metadata only — so a post-mortem works from the session file alone. Test harnesses route diagnostics into `.test-output` so synthetic events never pollute the user's operational log.
- Unpaired tool_uses in a session rebuild are paired with an explicit `is_error` result telling the model the output was lost and to re-run the tool if needed, instead of cc-session-io's bare `[no tool result recorded]` placeholder that models read as real output.
- Session rebuilds and deferred steer/follow-up continuations preserve mixed text/image user content as real Anthropic image blocks. An output-less aborted assistant turn is labeled as interrupted rather than with the generic incompatible-content marker, so a later `continue` cannot mistake the interruption placeholder for a rejected image.
- A pre-output Claude `Prompt is too long` rejection may come from a stale or independently bloated child transcript even while Pi's canonical context is valid. The bridge marks that child session for rebuild, discards the rejected attempt, and retries the same logical request once from Pi history. A second rejection is surfaced so Pi can compact canonical context instead of looping or replaying side effects.

## Child-executed tools (claude.ai connectors)

Tool calls in a bridge turn normally run in one direction: Pi hands its tool set to the bridge, the bridge re-offers it to the `claude` child over the in-process MCP server, and a `tool_use` coming back is the child asking **Pi** to execute something. claude.ai connectors run the other way — they are the child's own MCP servers, attached to the authenticated account and reachable only from inside that process.

So a `tool_use` under `mcp__claude_ai_` is **never mirrored into the Pi stream**: no `toolCall` block, no `toolUse` turn boundary, no entry in the turn's expected-result tracking (`isChildExecutedTool` in `src/connectors.ts`; the three emission sites in `src/assistant-stream.ts`). The child executes the call itself and keeps streaming, so the whole exchange lands in one Pi assistant message.

Mirroring one used to make Pi's agent loop look the name up in `context.tools`, miss, and write a synthetic `Tool <name> not found` error result into the transcript — for a call that had **succeeded**, next to an answer built from its real payload. That reads as a fabricating model, and a rebuild (`syncSharedSession`) projected the false result back into the child's session, turning a wrong mirror into a wrong conversation of record. Found in two host apps at once (drovr#311, memsira#320).

Two places used to hand the model a SECOND name for a connector tool, and a second name is a name that can be wrong:

- `mapPiToolNameToSdk` PascalCased anything it could not map, so a connector call projected back into the child's session became `McpClaudeAiSlackSlackSearchChannels`. The model imitated that alias on the next turn and got a real `Tool ... not found` from the MCP dispatcher before retrying the canonical name — one wasted round-trip per affected call. Connector names now pass through unchanged; the fix above stops them reaching this path at all, but LEGACY Pi history recorded before it still carries them.
- `resolveMcpTools` re-offered every `context.tools` entry under the bridge's own MCP prefix, including one sitting on the connector namespace. Such a tool is uncallable anyway (a `tool_use` there is treated as child-executed and never handed to Pi), so it is now filtered out and the two halves agree end to end.

The classifier is namespace-based on purpose. "Any name Pi cannot resolve" would also swallow a genuine Pi↔child tool-name mismatch, which should stay a loud dispatcher error.

Two consequences worth knowing:

- The child's real result is **observed, never re-delivered** (`noteChildExecutedToolResults`, fed from the SDK's `user` message). It already reached the model inside the child. The debug line records the tool name, error flag, and payload byte size — never the payload, which is live account data and the bridge's debug log sits outside a host app's redaction boundary.
- A connector call still produces **no tool card**. Pi's assistant content is `text | thinking | toolCall`, and any `toolCall` block is dispatched by its agent loop, so there is no way to say "a call happened, someone else ran it" as content — the honest options were "absent" or "present and wrong". Rendering one needs a Pi-side representation for delegated calls, which is an upstream ask.

### The audit trail

What the transcript *can* carry is a record that is not content. Each child-executed call appends a session `CustomEntry` of type `claude-bridge-connector-call` (`src/connector-audit.ts`), which pi documents as *"Does NOT participate in LLM context (ignored by `buildSessionContext`)"*: it is never a content block, so the agent loop cannot dispatch it, and `convertPiMessages` reads messages rather than entries, so it is never projected back into the child's session. **Never use `CustomMessageEntry`** for this — the sibling type DOES enter context, which is the whole bug again.

Each record is `{ name, toolUseId, outcome, byteSize?, childSessionId?, reason? }` — enough to pair it to the child's own transcript by `tool_use_id`, and no payload.

Two things the shape is deliberate about:

- `outcome` is `ok | error | **unobserved**`. A call whose result never came back (abort, stream-idle timeout, a query that just ended) is recorded at teardown naming the cause, beside the Pi-side `drainPendingToolCalls`. Silence there would leave an answer in the transcript as the only evidence a call was ever made — the same "can I trust this?" question the mirrored `Tool ... not found` answered wrongly.
- Recording is keyed on the `tool_use` id, not on the call site. The SDK can re-yield a `user` message, and either path (result or teardown) can reach a call first; one call is one record, whichever gets there.

The audit map is query-scoped and is NOT cleared by `resetToolTracking` — that runs at every child message boundary, and clearing it there would make a call abandoned in an earlier child message unrecordable at teardown, which is the one case the trail exists for.

Note that pi/core's `createBranchedSession` copies every non-label entry root→leaf, so a fork inherits the parent's connector-call records. Harmless for an audit trail, unlike the `claude-bridge-session` marker it sits beside, which needed a `piSessionId` guard for exactly that reason.

## Optional account-router contract

The bridge remains usable by itself. A companion may publish `vstack.pi.claude-account-router.v1` on `globalThis` to supply a subscription profile for each fresh request. The bridge passes only an opaque profile id, display label, and optional `CLAUDE_CONFIG_DIR`; credentials remain owned by the official Claude CLI.

Account selection affects every account-scoped surface together:

- the Agent SDK child environment;
- `cc-session-io` create/open/delete paths and persisted bridge-session markers;
- Claude session resume IDs;
- connector inventory/cache scope;
- structured `accountInfo()` and experimental `/usage` feedback.

A failed pre-output attempt is buffered so protocol setup frames do not leak into Pi, then retried with the failed profile excluded. Text/thinking deltas, Pi tool calls, and child-executed connector dispatches commit the request permanently; failures after that point are surfaced and never replayed, but are still recorded for the next request's routing decision. `rate_limit_event` reset timestamps are sent back to the router before reranking.

The reciprocal `vstack.pi.claude-bridge.account-host.v1` service exposes a local `/usage` probe for account-management commands. Both symbols carry `version: 1`; incompatible future shapes must use a new symbol/version instead of mutating this contract in place.

## Provider registration — native pi ≥0.81 provider API (adopted in 2.0)

Since 2.0 the bridge registers a native `Provider` object (`native-provider.ts`) via
`pi.registerProvider(provider)`: registration is UNCONDITIONAL (once primary) for canonical `pi-claude` and the saved-session compatibility alias `claude-bridge`; the provider's
own `auth.apiKey.check()/resolve()` report configured-ness from the same existence-only credential
probes as before (`auth-presence.ts`), so pi itself hides both provider aliases while no Claude
account is connected and shows them when one appears. The 1.x credential-gated
register/unregister state machine (`decideRegistration`) is gone. **Hosts must embed pi ≥0.81**
(peer range `>=0.81.0`); on an older host the extension declines loudly once
(`NATIVE_PROVIDER_UNSUPPORTED_MESSAGE`) instead of registering wrongly through the legacy overload.

This was first evaluated on 2026-07-28 and NOT adopted, then adopted the same day after the owner
lifted the pre-0.81 host-compat constraint (memsira/drovr upgrade their embedded pi in lockstep —
they are the only consumers). What the original evaluation flagged, and how each point resolved:

- **The symbol guards stay — by design, not oversight.** pi's `registerNativeProvider` is
  upsert-by-id that *replaces* the stored provider object; an unguarded subagent module reload
  re-registering the same id would swap in ITS `streamSimple` closure and split-brain the shared
  session. `PRIMARY_INSTANCE_KEY`/`ACTIVE_STREAM_SIMPLE_KEY` therefore survive into 2.x. If pi
  ever grows owner-aware provider dedupe, the guards can go.
- **The two-parallel-paths objection dissolved** with the host floor at 0.81: there is exactly one
  registration path in 2.x.
- **Mid-session credential timing is kept deterministic** rather than left to pi's refresh
  cadence: session_start and pre-spawn re-UPSERT the same provider object, which triggers pi's
  model-snapshot/availability recompute at exactly the boundaries 1.x re-checked — and the
  pre-spawn `hasClaudeCredentials()` fail-fast in `streamSimple` remains, so a logout is a clear
  actionable error at first use even if a picker snapshot is stale.
- The subscription-billing constraint is untouched: BOTH native stream entry points
  (`stream`/`streamSimple`) are the same Claude Code subprocess router — there is no raw-API path.

## Config channels

`loadConfig` layers three sources, lowest precedence first: `<piUserDir>/claude-bridge.json`, a trusted project's `.pi/claude-bridge.json`, then extension-manager config in `settings.json`. Isolated mode (`CLAUDE_BRIDGE_ISOLATED=1`) keeps only the first.

Each `claude-bridge.json` is read by `legacyFileConfig`, which accepts both the nested legacy shape (`provider.*`, `promptContext.*`) and the manager's flat manifest keys; nested wins when a file carries both for one key. Provider values are normalized once over the merged result, so an invalid `forceEffort` in a higher layer still clears a valid one below it.

`resolveExternalConfigValue(key, cwd)` reports what those files — and only those files — resolve for one manifest key, plus the concrete file that supplied it. It shares `legacyLayers`/`mergeLayers` with `loadConfig` and applies the same normalization, so the two cannot drift. `registerExternalConfigResolver` publishes it under `Symbol.for("vstack.pi.extension-config-resolver")` keyed by `PACKAGE_ID`; the vstack extension manager calls it when neither of its own scopes holds a key, and renders the value with its source file. Registration happens before the `config.enabled === false` early return, because a bridge disabled by `claude-bridge.json` is precisely the case the settings editor has to explain. The contract itself is documented in [`pi-extension-manager/DEVELOPMENT.md`](../pi-extension-manager/DEVELOPMENT.md).

## Connector write enforcement

Write denial with `connectorWriteMode: "deny"` is two-layered:

- **Model context:** the known write tools are passed as `disallowedTools` (exact tool ids). The CLI's MCP permission matcher only supports exact tool names or a whole-server `mcp__server__*` glob — partial tool-segment globs are inert — so exact ids are what actually removes today's writes.
- **Runtime:** a `PreToolUse` hook blocks any connector tool classified as a write at call time, regardless of permission mode. Classification is fail-closed over the whole `mcp__claude_ai_<Server>__` space: a tool there is a write unless its name *begins* with a known read verb (`list`, `search`, `get`, `read`, `fetch`, …). The verb is matched as a word across naming styles — `search_threads` (Gmail), `slack_read_channel` (Slack, server-prefixed), and `getJiraIssue` (Atlassian, camelCase) are all reads; a leading word that merely repeats the server name is skipped first. A name that opens with a read verb but also names a mutation (`getOrCreateChannel`) is a write, and so is a name that does not parse as `<server>__<tool>`.

## Connector inventory build artifacts

The `./connector-inventory` entry point is a separate build output. It cannot come from `bundle/index.js`, which exports only pi's extension registration and is tree-shaken against what `index.ts` itself calls — `connectorServerNamespace` was dropped from it entirely for that reason, which is why the root bundle explicitly re-exports the connector API. `tests/unit-connector-inventory-artifact.mjs` loads the built artifacts rather than `src/` so a source change without a rebuild fails.

## Diagnostics

- Rate-limit errors are deduplicated before user notification. The bridge emits `vstack:rate-limit` so `pi-qol` can opt into reset-time auto-resume.
- Stream-idle stalls close the stalled Claude Code subprocess and return a retryable assistant error. `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT` accepts bare seconds or `ms`, `s`, and `m` suffixes.
- The watchdog monitors inactivity for the full lifetime of each open Pi stream, including after thinking/text begins and after Pi delivers a tool result. Every SDK event (including pings and deltas) resets the timer. Pi-executed tool waits are naturally excluded because their turn stream is closed; child-executed claude.ai connector calls are excluded explicitly while their audit state is pending because those calls can legitimately suppress SDK events until the remote service returns. Processing the connector's result refreshes the watchdog after clearing that pending state.
- Integrity diagnostics are written to `<piUserDir>/claude-bridge-diag.log` (`PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`) with counts, affected tool names, and sampled tool-call IDs.
- `CLAUDE_BRIDGE_ISOLATED=1` (embedding hosts) disables all `AGENTS.md` discovery and all extension-manager/project config overlays, so bridge settings come only from `<piUserDir>/claude-bridge.json`. It also disables project `APPEND_SYSTEM.md` and the `$PATH` Claude executable search. This matters when an in-process host must share `PI_CODING_AGENT_DIR` with Pi but still needs an authoritative executable/connector policy. See `isolatedFromEnv` in `src/config.ts`.
- Startup preflight failures preserve the underlying `code`, `errno`, `syscall`, `path`, `cwd`, and detected executable file type before handing the error back to the SDK.
