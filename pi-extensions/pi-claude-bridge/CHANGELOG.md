# Changelog — pi-claude-bridge (ax fork)

## Unreleased

### Compaction and branch summaries run as isolated one-shot queries

Pi's compaction and branch-summary requests (`cacheRetention: "none"`) no longer go through the conversation's Claude Code session. Each one runs as its own short-lived query that has Pi's summarization system prompt as-is, no tools or MCP servers, no `resume`, and no persisted child session. It never touches the live query or the shared session cursor. Before this change, an auto-compaction that fired in the middle of a tool loop was written into the waiting query as a steer: the child waited for a tool result and Pi waited for the summary, so the turn hung until the stream-idle timeout (2 of 133 measured compactions). Now the turn continues. Between-turn `/compact` also stops re-reading the whole session transcript: it sends only the summary prompt, and the summary exchange no longer ends up in the main session history. Ordinary turns are unchanged (same resume, prompt cache, tools, and AGENTS.md forwarding). The first ordinary turn after a compaction still rebuilds the Claude session from the compacted Pi history.

Known limitation: when compaction happens mid tool loop, the rest of that turn still finishes in the pre-compaction Claude session. This costs more tokens but cannot deadlock, and the next turn's rebuild brings the session back to the compacted history. Restarting the live query at the compaction point, so the tool results are handed over only once (upstream KEN-1473), is separate work.

Tests: `tests/unit-one-shot-summary.mjs` and `tests/int-compact-mid-tool-loop.mjs` (live).
