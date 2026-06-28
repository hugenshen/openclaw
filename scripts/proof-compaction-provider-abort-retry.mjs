/**
 * Real-behavior proof: compaction retries provider-side AbortErrors when the
 * caller AbortSignal is not aborted, and still stops on caller cancellation.
 *
 * Exercises production modules:
 *   - src/agents/compaction.ts (summarizeWithFallback → summarizeChunks → retryAsync)
 *   - src/agents/agent-hooks/compaction-safeguard.ts (tryProviderSummarize → LLM fallback)
 *
 * Usage: node scripts/proof-compaction-provider-abort-retry.mjs
 */
import { spawnSync } from "node:child_process";

const cases = [
  {
    label: "compaction.ts retries undici AbortError when signal is not aborted",
    file: "src/agents/compaction.summarize-fallback.test.ts",
    pattern: "retries provider-side AbortError and returns a real summary",
  },
  {
    label: "compaction.ts stops immediately when caller signal is already aborted",
    file: "src/agents/compaction.summarize-fallback.test.ts",
    pattern:
      "does not retry and propagates AbortError immediately when caller signal is already aborted",
  },
  {
    label: "compaction-safeguard falls back to LLM after provider AbortError",
    file: "src/agents/agent-hooks/compaction-safeguard.test.ts",
    pattern:
      "falls back to LLM when provider throws a provider-side AbortError with signal not aborted",
  },
  {
    label: "compaction-safeguard propagates AbortError when caller signal is aborted",
    file: "src/agents/agent-hooks/compaction-safeguard.test.ts",
    pattern: "propagates provider AbortError and cancels when caller signal is already aborted",
  },
];

let allPassed = true;

for (const testCase of cases) {
  console.log(`\n=== ${testCase.label} ===`);
  const result = spawnSync(
    "node",
    ["scripts/run-vitest.mjs", "run", testCase.file, "-t", testCase.pattern, "--reporter=verbose"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  const ok = result.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} (exit=${result.status ?? "null"})`);
  if (!ok) {
    allPassed = false;
  }
}

console.log(`\n=== summary ===`);
console.log(allPassed ? "ALL PASS" : "SOME FAILED");
process.exit(allPassed ? 0 : 1);
