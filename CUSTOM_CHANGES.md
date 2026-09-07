# Custom Changes

This document tracks what's different in **OmniRoute Custom** (`adnanahamed66772ndpc/omniroute-custom`)
compared to upstream **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)**. Full attribution lives in the
[README's Upstream / Credits section](README.md#upstream--credits).

## Hermes Agent Optimization

Long-running [Hermes Agent](https://github.com/NousResearch/hermes-agent) coding sessions were resending their
full accumulated context on every turn with prompt compression disabled by default, causing rapid, unnecessary
token growth. Changes:

- **Adaptive prompt-compression threshold API** — the proactive-compression trigger ratio (previously DB-only,
  no way to tune without a raw SQLite write) now has a settings route:
  `GET`/`PUT /api/settings/compression/proactive-threshold`.
- **Compression benchmark/regression coverage** for long agentic sessions, proving the existing RTK + aggressive +
  caveman stacked pipeline correctly compacts a growing tool-output-heavy conversation — recency protection,
  durable-fact preservation, tool-call pairing, and cache-prefix stability all verified against a realistic
  fixture, plus translation correctness for both the Codex/`openai-responses` and Antigravity/Gemini request paths.
- No compression engine internals were changed and no shipped default was flipped globally — see
  [README → Configuration](README.md) / the settings routes above for how to turn this on for your own traffic.

## Session Isolation

Independent Hermes sessions/projects must never share conversation context, even when they use the same API key.

Memory retrieval was hardcoded to `scope: "apiKey"` — pooling every session's saved memories under the owning API
key, even though the DB/query layer already supported per-session filtering. A single API key used across multiple
unrelated Hermes projects could therefore see another project's saved memories.

`toMemoryRetrievalConfig()` now scopes to `scope: "session"` when an operator opts in
(`memorySettings.sessionScopeEnabled`, **default `false`**) and the client sends the existing
`x-omniroute-session-id` header. With no session id present it falls back unchanged to the original apiKey-pooled
behavior — fully backward compatible by default. Enable via `PUT /api/settings/memory { "sessionScopeEnabled": true }`.

Regression tests (`tests/unit/memory/hermes-session-isolation.test.ts`) prove two sessions sharing one API key never
cross-contaminate, that a different API key never sees another key's memories, and that the opt-out default is
unchanged. Every other request-pipeline mechanism audited for this same class of leakage (message-body
construction, the conversation tracker, the semantic cache, compression telemetry, combo routing affinity/session
stickiness) was confirmed already isolated per request/API key — this was the one real gap.

## Usage / Accounting

No token-accounting semantics were changed. For reference, per-request usage in `call_logs`/`usage_history` already
distinguishes cached vs. fresh input, output, reasoning, and compressed-token counts — the new adaptive-threshold
setting above simply makes one more knob in that existing pipeline operator-configurable.

## Upstream

This project derives from **[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)**, branched from
`release/v3.8.51`. Licensed under the same [MIT License](LICENSE).

## Pulling future upstream updates

Upstream develops on a rolling `release/vX.Y.Z` branch (not `main` — `main` only receives periodic squash-merges of
finished releases). Check [the upstream repo](https://github.com/diegosouzapw/OmniRoute/branches) for the current
highest `release/v*` branch before syncing.

```bash
git fetch upstream

# Sync from the current active upstream release branch (recommended — most up to date):
git checkout main
git merge upstream/release/vX.Y.Z   # replace with the current highest release branch

# Or, for a lighter/less frequent sync, merge from upstream's main instead:
git merge upstream/main

# Resolve any conflicts, re-run the test suite, then commit the merge as usual.
```

Prefer merge over rebase here — rebasing would rewrite this repository's own custom commits on every sync, which
defeats the point of keeping them as a distinct, reviewable history on top of upstream.
