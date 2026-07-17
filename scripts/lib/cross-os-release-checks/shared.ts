import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveCommandPath(command: string) {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates =
    process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")
      ? [`${command}.cmd`, `${command}.exe`, command]
      : [command];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

export function shellEscapeForSh(value: string) {
  return value.replace(/'/gu, `'"'"'`);
}

export function trimForSummary(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 600) {
    return trimmed;
  }
  return `${trimmed.slice(0, 600)}...`;
}

export function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** Milliseconds left before an absolute deadline. May be zero or negative. */
export function remainingMs(deadline: number, now = Date.now()): number {
  return deadline - now;
}

/**
 * Caps a per-attempt timeout to the remaining deadline budget.
 * Callers must check remainingMs(deadline) > 0 before starting work that needs a timeout.
 */
export function clampTimeoutMs(deadline: number, maxMs: number, now = Date.now()): number {
  return Math.max(1, Math.min(maxMs, deadline - now));
}

/**
 * Polls until `attempt` returns "done" or the deadline is exhausted.
 * Each attempt receives the clamped timeout and the absolute deadline so that
 * multi-step callbacks (e.g. status probe + port check) can clamp every
 * sub-operation to the remaining budget. Interstitial sleep is also clamped.
 */
export async function pollUntilDeadline(params: {
  deadline: number;
  maxAttemptTimeoutMs: number;
  maxSleepMs?: number;
  attempt: (timeoutMs: number, deadline: number) => Promise<"done" | "retry">;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const sleepFn = params.sleepFn ?? sleep;
  const maxSleepMs = params.maxSleepMs ?? 2_000;
  while (remainingMs(params.deadline) > 0) {
    const outcome = await params.attempt(
      clampTimeoutMs(params.deadline, params.maxAttemptTimeoutMs),
      params.deadline,
    );
    if (outcome === "done") {
      return true;
    }
    if (remainingMs(params.deadline) <= 0) {
      break;
    }
    await sleepFn(clampTimeoutMs(params.deadline, maxSleepMs));
  }
  return false;
}

export function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
