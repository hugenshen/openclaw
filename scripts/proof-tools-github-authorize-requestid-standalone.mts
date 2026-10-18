// Real Gateway proof for clipboard-padded tools.github authorization ids.
// Seeds a local pending device record, then polls and cancels it over a real
// Gateway WebSocket. A future nextPollAtMs keeps the poll on that record.
// Run: node --import ./scripts/tsx.mjs scripts/proof-tools-github-authorize-requestid-standalone.mts
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  writeGitHubDeviceAuthorizationRecord,
  type GitHubDeviceAuthorizationRecord,
} from "../src/agents/github-oauth-records.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const POLL_DELAY_MS = 120_000;

type PollPayload = { status?: string; retryAfterMs?: number };
type CancelPayload = { cancelled?: boolean };
type StartedGateway = {
  startupSettled: Promise<void>;
  close: () => Promise<void>;
};

function deviceRequestId(): string {
  return `github-device-${randomBytes(16).toString("hex")}`;
}

function clipboardPad(requestId: string): string {
  return `  ${requestId}  `;
}

function pendingRecord(requestId: string, now: number): GitHubDeviceAuthorizationRecord {
  return {
    version: 1,
    requestId,
    deviceCode: "s".repeat(40),
    userCode: "WXYZ-1234",
    verificationUri: "https://github.com/login/device",
    createdAtMs: now,
    expiresAtMs: now + 900_000,
    pollIntervalMs: 5_000,
    nextPollAtMs: now + POLL_DELAY_MS,
    agentId: "main",
    scope: "system",
    expectedIdentity: null,
  };
}

function redact(text: string): string {
  return text
    .replace(/github-device-[a-f0-9]{32}/giu, "[request-id]")
    .replace(/\b[A-Za-z0-9_-]{40}\b/gu, "[redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPoll(value: unknown): PollPayload {
  if (!isRecord(value)) {
    throw new Error("authorization poll payload was not an object");
  }
  return {
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

function readCancel(value: unknown): CancelPayload {
  if (!isRecord(value) || typeof value.cancelled !== "boolean") {
    throw new Error("authorization cancel payload was not a boolean result");
  }
  return { cancelled: value.cancelled };
}

function samePending(left: PollPayload, right: PollPayload): boolean {
  return (
    left.status === "pending" &&
    right.status === "pending" &&
    typeof left.retryAfterMs === "number" &&
    typeof right.retryAfterMs === "number" &&
    left.retryAfterMs > 0 &&
    right.retryAfterMs > 0 &&
    Math.abs(left.retryAfterMs - right.retryAfterMs) < 5_000
  );
}

function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : undefined;
      server.close((error) => {
        if (error || port === undefined) {
          reject(error ?? new Error("loopback port was not reserved"));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main(): Promise<void> {
  const token = randomUUID();
  const port = await reserveLoopbackPort();
  const identityDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-gh-auth-proof-"));
  const state = await createOpenClawTestState({
    label: "tools-github-authorize-proof",
    layout: "home",
    applyEnv: true,
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_LOG_LEVEL: "silent",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  let server: StartedGateway | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    await state.writeConfig({
      agents: { entries: { main: {} } },
      gateway: {
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      hooks: { enabled: false },
    });
    const now = Date.now();
    const sharedId = deviceRequestId();
    const rawOnlyId = deviceRequestId();
    // The Gateway process owns this database once it starts. Seed while it is still offline.
    await writeGitHubDeviceAuthorizationRecord(pendingRecord(sharedId, now));
    await writeGitHubDeviceAuthorizationRecord(pendingRecord(rawOnlyId, now));
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: state.stateDir }),
    );
    const { startGatewayServer } = await import("../src/gateway/server.js");
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    await server.startupSettled;
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ["operator.admin"],
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: path.join(identityDir, "device.sqlite"),
      }),
      requestTimeoutMs: 20_000,
      timeoutMs: 30_000,
    });
    const padded = clipboardPad(sharedId);
    if (padded.trim() !== sharedId || padded === sharedId) {
      throw new Error("clipboard padding did not change the request id");
    }
    const rawPoll = readPoll(
      await client.request("tools.github.authorize.poll", { requestId: sharedId }),
    );
    const paddedPoll = readPoll(
      await client.request("tools.github.authorize.poll", { requestId: padded }),
    );
    const rawCancel = readCancel(
      await client.request("tools.github.authorize.cancel", { requestId: rawOnlyId }),
    );
    const paddedCancel = readCancel(
      await client.request("tools.github.authorize.cancel", { requestId: padded }),
    );
    const afterCancel = readPoll(
      await client.request("tools.github.authorize.poll", { requestId: sharedId }),
    );
    const rawMatches =
      samePending(paddedPoll, rawPoll) &&
      paddedCancel.cancelled === true &&
      rawCancel.cancelled === true &&
      afterCancel.status === "expired";
    console.log(
      `[tools-github-authorize proof] raw_poll=${rawPoll.status ?? "missing"} padded_poll=${paddedPoll.status ?? "missing"}`,
    );
    console.log(
      `[tools-github-authorize proof] raw_cancel=${String(rawCancel.cancelled)} padded_cancel=${String(paddedCancel.cancelled)} after_cancel=${afterCancel.status ?? "missing"}`,
    );
    console.log(
      `[tools-github-authorize proof] padded_poll=${paddedPoll.status ?? "missing"} padded_cancel=${String(paddedCancel.cancelled)} raw_matches=${String(rawMatches)}`,
    );
    if (!rawMatches || paddedPoll.status !== "pending" || paddedCancel.cancelled !== true) {
      throw new Error("padded authorization did not match the raw pending and cancelled results");
    }
  } catch (error) {
    console.error(
      `[tools-github-authorize proof] failed ${redact(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
  } finally {
    if (client) {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
    await server?.close().catch(() => undefined);
    await state.cleanup().catch(() => undefined);
    await rm(identityDir, { recursive: true, force: true });
  }
}

await main();
