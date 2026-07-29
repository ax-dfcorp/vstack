# Cross-Repo Notes

The mailbox between vstack and its consuming repos (drovr, memsira, hyprtrade). `cross-repo.md`
beside this file is the **contract** and stays curated; this file is an append-only **log** so a
finding survives a scrolled-away tmux pane.

Format: newest entry at the top of `# Log`. Each entry opens with a date + the repo and PR it came
from, and tags its claims `[live]` / `[corroborated]` / `[inferred]` per `cross-repo.md`
§ *Recording Facts Across Repos* — do not restate those definitions here.

PR numbers collide between the repos, so always write `memsira #NNN` / `drovr #NNN`.

# Log

## 2026-07-29 — memsira: bridge 2.0.0 + pi 0.82.1 landed (memsira PR pending, branch `bridge-2`)

Re-vendored `pi-claude-bridge` 2.0.0 from vstack `main`; the bridge dir is unchanged since
`7399c1e3`, so the vendored bundle is byte-identical to upstream (sha256
`b4dfa3d7…f9a3f66a`). `@earendil-works/pi-ai` + `pi-coding-agent` bumped 0.80.10 → 0.82.1 together.

**The 2.0 upgrade needed no pi-0.82 compile fixes in memsira.** `[live]` The sidecar embeds pi
deeply (constructs `ModelRuntime` / `ModelRegistry` / `createAgentSessionRuntime` directly), and the
upgrade guide flagged 0.80.8's `ModelRuntime` internals change as the likely first breakage. Nothing
broke: typecheck, build and the sidecar suite were green on the first run after `pnpm install`.
drovr should expect the same, and should not budget for a pi-side port.

**Unconditional registration changes what a credential-less turn LOOKS like, and the new failure is
worse than the old one.** `[live, memsira box, real Claude account, pi 0.82.1, bridge 2.0.0]` Under
1.x, a turn with no Claude credentials failed with `model not found: claude-bridge/…`. Under 2.0 the
model resolves and **pi's own preflight** rejects the prompt with:

```
No API key found for claude-bridge.

Use /login to log into a provider via OAuth or API key. See:
  /<abs>/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  /<abs>/node_modules/@earendil-works/pi-coding-agent/docs/models.md
```

Two absolute install paths and a `/login` flow that does not exist in a desktop app — straight into
a chat bubble. The bridge's own "Claude account not connected — connect an account…" pre-spawn
fail-fast never runs, because pi refuses first. **Any host embedding pi and the bridge has this**, so
drovr will hit it too. memsira's fix: detect the CONDITION (`getProviderAuthStatus("claude-bridge")`
→ `{configured: false}`), not pi's message text, and replace the user-facing copy while logging the
original. Matching the prose would silently stop working the next time pi rewords its preflight.

**Availability numbers, for anyone verifying their own wiring.** `[live]` Same process, same
account: no credentials → `getAll()` has 8 `claude-bridge` models, `getAvailable()` has **0**,
`sdk.auth.list` reports `{configured: false}`. With credentials → **8** available and
`{configured: true, source: "environment", label: "Claude Code login"}`. Credentials appearing
**mid-process** flip 0 → 8 at the next `start_session`, with no restart — the re-upsert at session
start works as documented.

**`claude-bridge` now appears in a pi auth listing even when unconfigured.** `[live]` memsira's
`sdk.auth.list` handler unions providers from `modelRegistry.getAll()`, so the bridge is always in
the list now. That was harmless here only because memsira's status decode already maps
`{configured: false}` → `NeedsSetup` → logged-out. A consumer that treats *presence in the auth
list* as *connected* would now claim a connection that does not exist.

**Post-re-vendor audits, against the SHIPPED bundle.** `[live]` Export surface 1.10.1 → 2.0.0:
**0 removed, 0 type-changed, 5 added** (`buildNativeProvider`, `supportsNativeProvider`,
`claudeAuthSourceLabel`, `NATIVE_PROVIDER_UNSUPPORTED_MESSAGE`, `isUsageLimitMessage`).
`decideRegistration` was already not an export in 1.10.1, so its removal is not a surface change.
`CONNECTOR_WRITE_TOOLS`: **32 denied / 15 gated / nothing bypassable**, and the five namespaces
`connectorServerNamespace()` derives still match the ids memsira hard-codes. Connector behaviour is
unchanged: one real Slack read executed in the child, left its `claude-bridge-connector-call`
CustomEntry, and produced **zero** Pi `toolCall`/`toolResult` records — the post-#932 behaviour
holds across the major.

**Usage-limit classification is worth importing, not re-implementing.** `[inferred, from
`src/rate-limit.ts`]` `isUsageLimitMessage` is a substring match against the Agent SDK's
`USAGE_LIMIT_ERROR_PREFIXES`, which is `@alpha` and degrades to `[]` if a release drops it;
`isExtraUsageRequiredMessage` is a loose regex (`overage`, `1M context`) that can match unrelated
prose. memsira treats both as "usage limit" but always shows the message verbatim, so a
mis-classification costs a wrong badge rather than a wrong story. A consumer that hard-copied the
prefix list would drift silently on the next SDK bump.
