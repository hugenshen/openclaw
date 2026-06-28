## What Problem This Solves

Fixes an issue where long-running agent sessions would silently lose conversation context during compaction when the LLM API closed a connection mid-stream without the user cancelling the run.

PR #90908 fixed this classification for the outer `model-fallback` layer, but the inner compaction retry path still treated provider-side `AbortError`s (for example undici's `"This operation was aborted"`) as terminal user cancellations. That suppressed retries in `summarizeChunks` and skipped the LLM fallback in `compaction-safeguard` when a configured compaction provider disconnected the same way.

The user-visible symptom: compaction appeared to succeed (`compacted: true`) but the stored summary was a degraded placeholder such as `"Summary unavailable due to size limits"`, erasing useful history without an obvious error.

## Why This Change Was Made

The fix aligns inner compaction error handling with the #90908 pattern: only treat an error as a caller-initiated cancellation when `AbortSignal.aborted` is true. Provider-side `AbortError`s with an unaborted signal are retried (LLM path) or fall back to built-in LLM summarization (provider path). Real non-abort transport timeouts such as `"fetch failed"` / `ETIMEDOUT` keep the existing no-retry behavior.

`summarizeWithFallback` now rethrows on caller abort instead of swallowing the error into the placeholder fallback path.

## User Impact

- Default LLM compaction: transient provider disconnects during summarization are retried instead of producing placeholder summaries.
- Configured compaction provider: provider disconnects fall back to LLM summarization instead of aborting the safeguard path.
- Explicit user/system cancellation (`signal.aborted`) still stops immediately with no retry.

## Evidence

**Behavior or issue addressed:** Provider-side `AbortError` during compaction no longer suppresses retries or LLM fallback when the caller has not cancelled.

**Real environment tested:** macOS, Node 22, local OpenClaw source checkout on branch `fix/compaction-provider-abort-retry`, production modules `src/agents/compaction.ts` and `src/agents/agent-hooks/compaction-safeguard.ts`.

**Exact steps or command run after this patch:**

```bash
pnpm build
pnpm test src/agents/compaction.summarize-fallback.test.ts src/agents/agent-hooks/compaction-safeguard.test.ts src/agents/compaction.retry.test.ts
node scripts/proof-compaction-provider-abort-retry.mjs
```

**Evidence after fix:**

```text
$ pnpm test src/agents/compaction.summarize-fallback.test.ts src/agents/agent-hooks/compaction-safeguard.test.ts src/agents/compaction.retry.test.ts
 Test Files  3 passed (3)
      Tests  106 passed (106)

$ node scripts/proof-compaction-provider-abort-retry.mjs
PASS compaction.ts retries undici AbortError when signal is not aborted (exit=0)
PASS compaction.ts stops immediately when caller signal is already aborted (exit=0)
PASS compaction-safeguard falls back to LLM after provider AbortError (exit=0)
PASS compaction-safeguard propagates AbortError when caller signal is aborted (exit=0)

=== summary ===
ALL PASS
```

Proof script exercises the real production call chains:

- `summarizeWithFallback` → `summarizeChunks` → `retryAsync` (compaction.ts)
- `session_before_compact` → `tryProviderSummarize` → LLM fallback via `summarizeInStages` (compaction-safeguard.ts)

Regression tests mock only the external LLM API boundary (`generateSummary` / provider `summarize`); all classification and retry/fallback orchestration runs through production code.

**Observed result after fix:** Provider-side `AbortError` with unaborted signal triggers a second `generateSummary` call and returns `"recovered summary after provider disconnect"`; safeguard provider failure invokes `summarizeInStages` instead of `{ cancel: true }`. Caller-aborted signal still throws immediately with a single attempt.

**What was not tested:** Live gateway compaction against a real provider that disconnects mid-stream; Crabbox `pnpm check:changed` (local Crabbox unavailable).

**Proof limitations or environment constraints:** Proof uses production compaction modules with mocked LLM/provider network boundaries. No live network disconnect was injected during proof.

## Tests and validation

- `pnpm build` — pass
- `pnpm test src/agents/compaction.summarize-fallback.test.ts src/agents/agent-hooks/compaction-safeguard.test.ts src/agents/compaction.retry.test.ts` — 106 passed
- `node scripts/run-oxlint.mjs --tsconfig tsconfig.json src/agents/compaction.ts src/agents/agent-hooks/compaction-safeguard.ts` — pass
- Regression tests added in `src/agents/compaction.summarize-fallback.test.ts` and `src/agents/agent-hooks/compaction-safeguard.test.ts`

## Risk checklist

- Did user-visible behavior change? **Yes** — compaction now retries/fallbacks on provider disconnects instead of silently degrading summaries.
- Did config, environment, or migration behavior change? **No**
- Did security, auth, secrets, network, or tool execution behavior change? **No**
- Highest-risk area: compaction retry loop could retry provider-side aborts up to 3 times before falling back.
- Mitigation: retries are bounded (3 attempts, existing backoff); caller abort remains terminal; non-abort timeouts unchanged.

## Current review state

- Next action: awaiting maintainer review
- Bot comments addressed: none yet

Related: #90908 (outer model-fallback fix; this PR completes the inner compaction layers)

_AI-assisted._
