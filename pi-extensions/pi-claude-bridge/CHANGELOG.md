# Changelog — pi-claude-bridge (ax fork)

## Unreleased

### Every trailing user message is the prompt, not only the last one

Pi appends each steer that arrives in the same tool boundary as its own user message, so a context can end with two or more user messages. The bridge sent only the last one to Claude; the earlier ones were imported into the session file as history and never answered. Observed 2026-10-13: two Daseo `notifyOnFinish` notices for research workers landed 85 ms apart, the parent saw only the second, and the first worker looked unfinished until the user asked. `extractUserPrompt` and `extractUserPromptBlocks` now take the whole trailing run of user messages, joined with a blank line (images from every message kept, in order), and the session sync drops that many trailing messages instead of a fixed one. The live-steer path uses the same extractor, so two steers pushed into an active query arrive together too.

Tests: `tests/unit-user-prompt.mjs`.

### Agent SDK 0.3.296, verified on pi 1.1.0 and Claude Code 2.1.296

The bundled Claude Agent SDK moves from 0.3.285 to 0.3.296 and the pi dev pins from 0.99.1 to 1.1.0. No bridge source changed: the unit suite (528 pass, 2 environment skips) and typecheck pass on pi 1.1.0, and the peer range stays `>=0.81.0`. Claude Code 2.1.286–2.1.296, which the bridge resolves from `PATH`, has no breaking change for `-p`/SDK sessions; 2.1.296 raises the MCP tool-description length sent up front from 2,048 to 4,096 characters and no longer stops a background command 5 seconds after the final result of a `-p`/SDK run. `tests/int-smoke.sh` now passes `--model` with `--provider claude-bridge`: pi 1.0 rejects `--provider` alone, and before that it silently ran another provider's default model, so the case never reached the bridge.

### Agent SDK 0.3.285, verified on pi 0.99.1 and Claude Code 2.1.285

The bundled Claude Agent SDK moves from 0.3.280 to 0.3.285 and the pi dev pins from 0.87.1 to 0.99.1. No bridge source changed: pi 0.99 removed none of the exports the bridge reads (`getCurrentSystemPrompt`/`getCurrentTools` are still pi-ai root exports), the peer range stays `>=0.81.0`, and the unit suite and typecheck pass on 0.99.1. Claude Code 2.1.281–2.1.285, which the bridge resolves from `PATH`, keeps SDK deferred tool calls and completed results across worker restarts and fixes resumed-session prompt-cache and history bugs; Sonnet 5.5 needs 2.1.284 or later.

### A model substitution restarts the live query at the next tool round

When Claude Code answers with a different model than the session requested (its refusal fallback, for example Opus 5 for Opus 5.5), the bridge now restarts at the next Pi callback instead of waiting for the next prompt. It stops delivering tool results into that query, discards it, and re-runs the turn on a fresh Claude session: a `model-substitution` rebuild with a new session id, never a resume of the swapped one. Before, the 2026-09-27 fix only restarted on the next prompt, and steers and follow-ups kept one query live for hours. One Opus 5.5 session ran 652 turns on Opus 5 on 2026-09-29, with no restart. The discard reuses the compaction-restart path, including its settlement wait and the continuation from the tool-result tail. A steer handed over with the tool results becomes the re-run's prompt. The substituted turn already shown stays in Pi history under the requested model id. If the fresh session is substituted again, the bridge stops after two consecutive restarts and delivers normally. It then warns once that the session continues on the substitute until the agent restarts or the model is switched. A turn answered by the requested model resets that count, which is kept per Pi session. The substitution warning now appears once per streak instead of once per tool round. The first query of a fresh Pi session, which has no shared session to mark, now also leaves its session due for a rotated rebuild, so the next prompt no longer resumes the swapped session. Diagnostics: `model_substitution_restart` and `model_substitution_restart_capped` in the diag log, and a new drain cause `model-substitution-restart`.

Tests: `tests/unit-model-substitution-restart.mjs`.

### Two parallel calls of the same tool pair with their own results

A message with two calls of the same tool (two `mcpScript` or two `read` calls) could lose both results: the bridge could not tell which MCP handler belonged to which call, returned `no matching tool_call id` to the model, and dropped Pi's real results as stale (20 such tool results in 30 days, 16 in turns with two calls of one tool; live repro 2026-09-29 01:17Z). The records and the handler's input now compare through the same tool schema the SDK validates with, so an undeclared key the model added (`timeout` on mcpScript) no longer makes the two differ. A handler that runs before its call's arguments are final waits for them instead of guessing between same-name calls. A lone call of its tool still pairs as before.

Tests: `tests/unit-same-tool-parallel-claims.mjs`.

### AGENTS.md forwarding matches Pi: global file plus every ancestor

The bridge now forwards the same context files Pi loads for its own system prompt: `<piUserDir>/AGENTS.md` first, then every `AGENTS.md` (or Pi's other candidate names) from the filesystem root down to the working directory, deduped by realpath, each in its own `<project_instructions path="...">` block under `# CLAUDE.md`. Before, only the nearest file was forwarded, so a Claude session inside a repository with its own AGENTS.md never received the rules in `~/AGENTS.md` or the global file, although GPT sessions on Pi did (found 2026-09-24). Live sessions receive the longer append once, as a `<system_prompt_update>` on their next turn. Isolated mode still forwards nothing.

Tests: `tests/unit-agents-md.mjs`; `tests/unit-isolation.mjs` updated for the new resolver.

### A compaction mid tool loop restarts the live query on the compacted history

When Pi's threshold auto-compaction fires inside a tool loop, the bridge no longer delivers that turn's tool results into the live Claude Code query. That query was still on the pre-compaction transcript, so the model kept seeing the full history. Pi's threshold check then fired again after every tool round, and each repeat was another full, uncached summary call: three in a row at 917k → 930k → 941k tokens in one session on 2026-09-23, with the Claude session id and `lastSync` frozen throughout. Now the provider detaches the live query from Pi's stream, closes it, and waits for it to settle. Teardown drains its waiting MCP handlers with the new `compaction-restart` cause, and the provider re-runs the same call. That re-run takes the REBUILD path (`rebuildReason=session_compact`, fresh session id) from Pi's compacted context, which already holds the summary, the kept tail, and the tool results. It continues from the tool-result tail the same way a turn-boundary compaction does. The only visible difference is that the turn no longer re-compacts. Session-tree rewrites during a live query take the same path. The same applies to the first query of a fresh Pi session, which has no shared session until it completes (a long single-prompt agent spends its whole task in it). The rewrite is recorded on that live query, and teardown turns the child's session id into a shared session due for the compaction rebuild. If that id was never captured, the re-run takes the ordinary first-turn rebuild instead. Genuine aborts, ordinary tool-result delivery, steering, and the one-shot summary lane are unchanged. Nested (subagent) query contexts keep the previous behaviour. Diagnostics: `compaction_active_query_restart` in the diag log, and the rebuild `syncResult` debug line now names its `reason`.

Tests: `tests/unit-compaction-restart.mjs`; `tests/int-compact-mid-tool-loop.mjs` now also asserts that the first post-compaction context is below the threshold, that a `session_compact` rebuild happened with a new session id, and that the tool output survived.

### Compaction and branch summaries run as isolated one-shot queries

Pi's compaction and branch-summary requests (`cacheRetention: "none"`) no longer go through the conversation's Claude Code session. Each one runs as its own short-lived query that has Pi's summarization system prompt as-is, no tools or MCP servers, no `resume`, and no persisted child session. It never touches the live query or the shared session cursor. Before this change, an auto-compaction that fired in the middle of a tool loop was written into the waiting query as a steer: the child waited for a tool result and Pi waited for the summary, so the turn hung until the stream-idle timeout (2 of 133 measured compactions). Now the turn continues. Between-turn `/compact` also stops re-reading the whole session transcript: it sends only the summary prompt, and the summary exchange no longer ends up in the main session history. Ordinary turns are unchanged (same resume, prompt cache, tools, and AGENTS.md forwarding). The first ordinary turn after a compaction still rebuilds the Claude session from the compacted Pi history.

Known limitation (resolved by the entry above): when compaction happened mid tool loop, the rest of that turn still finished in the pre-compaction Claude session.

Tests: `tests/unit-one-shot-summary.mjs` and `tests/int-compact-mid-tool-loop.mjs` (live).
