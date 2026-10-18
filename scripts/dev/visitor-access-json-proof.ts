// Real-fetch loopback proof for VisitorPolicyClient.
// Run: node --import ./scripts/tsx.mjs scripts/dev/visitor-access-json-proof.ts
// The listener is 127.0.0.1. Global fetch performs both requests; only the
// Cloudflare origin is rewritten onto that listener. Response bodies still
// go through readProviderJsonResponse's shared cap.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VisitorPolicyClient } from "../../extensions/visitor-access/src/cloudflare.js";
import type { VisitorAccessConfig } from "../../extensions/visitor-access/src/config.js";
import { VisitorAccessError } from "../../extensions/visitor-access/src/errors.js";

/** Default cap in src/agents/provider-http-errors.ts (PROVIDER_RESPONSE_MAX_BYTES). */
const SHARED_JSON_CAP_BYTES = 16 * 1024 * 1024;
const OVERSIZED_PADDING_BYTES = SHARED_JSON_CAP_BYTES * 2;
const POLICY_NAME = "Visitors (openclaw-managed)";
const API_TOKEN = "proof-token-not-logged";

const config: VisitorAccessConfig = {
  accountId: "proofaccount",
  appId: "proofapp",
  apiToken: API_TOKEN,
  policyName: POLICY_NAME,
  defaultTtlDays: 14,
  maxVisitors: 50,
};

type ProofMode = "normal" | "oversized";

type OversizedStats = {
  bytesWritten: number;
  total: number;
  closed: boolean;
  writableFinished: boolean;
};

function assertCloudflareRequest(req: IncomingMessage): void {
  const authorization = req.headers.authorization;
  if (authorization !== `Bearer ${API_TOKEN}`) {
    throw new Error("loopback request did not carry the production Authorization header");
  }
  if (req.method !== "GET") {
    throw new Error("loopback request did not use the production GET method");
  }
}

function endJson(res: ServerResponse, value: unknown): number {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
  return body.length;
}

function streamOversized(res: ServerResponse): { stats: OversizedStats; closed: Promise<void> } {
  const prefix = Buffer.from(
    `{"success":true,"result":[{"id":"visitor-policy","name":${JSON.stringify(POLICY_NAME)},"pad":"`,
  );
  const suffix = Buffer.from('"}]}');
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  const total = prefix.length + OVERSIZED_PADDING_BYTES + suffix.length;
  const stats: OversizedStats = {
    bytesWritten: 0,
    total,
    closed: false,
    writableFinished: false,
  };
  let closedResolve: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const finish = () => {
    if (stats.closed) {
      return;
    }
    stats.closed = true;
    stats.writableFinished = res.writableFinished;
    closedResolve();
  };
  res.on("close", finish);
  res.on("error", () => undefined);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });

  let pendingPrefix = true;
  let remaining = OVERSIZED_PADDING_BYTES;
  const writeNext = () => {
    if (stats.closed || res.destroyed || res.writableEnded) {
      return;
    }
    let payload: Buffer;
    if (pendingPrefix) {
      pendingPrefix = false;
      payload = prefix;
    } else if (remaining > 0) {
      const next = Math.min(remaining, chunk.length);
      remaining -= next;
      payload = chunk.subarray(0, next);
    } else {
      stats.bytesWritten += suffix.length;
      try {
        res.end(suffix);
      } catch {
        // The client already aborted the socket.
      }
      return;
    }
    let accepted: boolean;
    try {
      accepted = res.write(payload);
    } catch {
      return;
    }
    stats.bytesWritten += payload.length;
    if (!accepted) {
      res.once("drain", writeNext);
      return;
    }
    setImmediate(writeNext);
  };
  writeNext();
  return { stats, closed };
}

async function main(): Promise<void> {
  let mode: ProofMode = "normal";
  let normalBytes = 0;
  let sawList = false;
  let sawDetail = false;
  let oversized: { stats: OversizedStats; closed: Promise<void> } | undefined;
  let serverError: Error | undefined;

  const server = createServer((req, res) => {
    req.on("error", () => undefined);
    try {
      assertCloudflareRequest(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (mode === "oversized") {
        oversized = streamOversized(res);
        return;
      }
      if (url.pathname.endsWith("/policies") && url.searchParams.get("page") === "1") {
        sawList = true;
        normalBytes += endJson(res, {
          success: true,
          result: [{ id: "visitor-policy", name: POLICY_NAME }],
        });
        return;
      }
      if (url.pathname.endsWith("/policies/visitor-policy")) {
        sawDetail = true;
        normalBytes += endJson(res, {
          success: true,
          result: {
            id: "visitor-policy",
            name: POLICY_NAME,
            decision: "allow",
            include: [{ email: { email: "visitor@example.com" } }],
          },
        });
        return;
      }
      res.writeHead(404);
      res.end();
      serverError = new Error("unexpected visitor-access path");
    } catch (error) {
      serverError = error instanceof Error ? error : new Error("loopback request failed");
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof listener did not bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const loopbackFetch: typeof fetch = (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const original = new URL(rawUrl);
    if (original.protocol !== "https:" || original.hostname !== "api.cloudflare.com") {
      throw new Error("VisitorPolicyClient did not target the Cloudflare API host");
    }
    const target = new URL(`${original.pathname}${original.search}`, origin);
    return fetch(target, init);
  };
  const client = new VisitorPolicyClient(config, loopbackFetch);

  try {
    const read = await client.read();
    if (serverError) {
      throw serverError;
    }
    if (!sawList || !sawDetail || normalBytes <= 0) {
      throw new Error("normal Cloudflare JSON was not served through the production client");
    }
    if (read?.id !== "visitor-policy" || read.targets.join(",") !== "visitor@example.com") {
      throw new Error("normal Cloudflare JSON did not parse into the visitor policy");
    }

    mode = "oversized";
    let rejected = false;
    try {
      await client.read();
    } catch (error) {
      rejected =
        error instanceof VisitorAccessError &&
        error.message.includes("Cloudflare returned an unreadable response");
      if (!rejected) {
        throw error;
      }
    }
    if (!rejected || !oversized) {
      throw new Error("oversized Cloudflare JSON was not rejected by the production client");
    }
    await Promise.race([
      oversized.closed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
    const closedEarly =
      oversized.stats.closed &&
      !oversized.stats.writableFinished &&
      oversized.stats.bytesWritten < oversized.stats.total;
    if (!closedEarly) {
      throw new Error(
        `oversized stream was not closed early (written=${oversized.stats.bytesWritten} total=${oversized.stats.total} closed=${oversized.stats.closed} finished=${oversized.stats.writableFinished})`,
      );
    }

    console.log(
      `[visitor-access json proof] normal=ok bytes=${normalBytes} oversized=rejected closed_early=true cap=${SHARED_JSON_CAP_BYTES}`,
    );
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "visitor-access json proof failed";
  console.error(message.replaceAll(API_TOKEN, "[redacted]"));
  process.exitCode = 1;
}
