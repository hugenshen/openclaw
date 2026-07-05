import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClawRouterUsage } from "./usage.js";

const OVERSIZED_RESPONSE_BYTES = 18 * 1024 * 1024;

function createOversizedUsageServer(): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url !== "/v1/usage") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
      return;
    }
    let sentBytes = 0;
    let stopped = false;
    let prefixSent = false;
    const prefixChunk = Buffer.from('{"budget":{"configured":false},"payload":"');
    const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
    const suffixChunk = Buffer.from('"}');
    const writeBuffer = (buffer: Buffer) => {
      sentBytes += buffer.length;
      if (!res.write(buffer)) {
        res.once("drain", writeChunks);
        return false;
      }
      return true;
    };
    const writeChunks = () => {
      if (!prefixSent) {
        prefixSent = true;
        if (!writeBuffer(prefixChunk)) {
          return;
        }
      }
      while (true) {
        if (stopped) {
          return;
        }
        if (sentBytes + bodyChunk.length + suffixChunk.length >= OVERSIZED_RESPONSE_BYTES) {
          break;
        }
        if (!writeBuffer(bodyChunk)) {
          return;
        }
      }
      if (!stopped) {
        sentBytes += suffixChunk.length;
        res.end(suffixChunk);
      }
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.on("close", () => {
      stopped = true;
      resolveClosed(sentBytes);
    });
    req.on("aborted", () => {
      stopped = true;
      res.destroy();
    });
    writeChunks();
  });
  return { server, closed };
}

async function listenLoopbackServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }
  return address.port;
}

describe("ClawRouter usage", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("maps the managed monthly budget and usage totals", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        budget: {
          configured: true,
          ledger: "durable_object",
          windowKey: "default/test-policy/2026-07",
          limitMicros: 100_000_000,
          spentMicros: 25_000_000,
          remainingMicros: 75_000_000,
        },
        usage: {
          summary: {
            requestCount: 12,
            totalTokens: 34_567,
            actualCostMicros: 25_000_000,
          },
        },
      }),
    );

    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      baseUrl: "https://clawrouter.example/v1",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      provider: "clawrouter",
      displayName: "ClawRouter",
      windows: [
        {
          label: "Monthly budget",
          usedPercent: 25,
          resetAt: Date.UTC(2026, 7, 1),
        },
      ],
      summary: "12 requests · 34,567 tokens · $25.00 used",
      plan: "Managed monthly budget",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://clawrouter.example/v1/usage",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer proxy-key",
        },
      }),
    );
  });

  it("shows aggregate usage for an unmetered key", async () => {
    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async () =>
        Response.json({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 0, totalTokens: 0, actualCostMicros: 0 } },
        }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows).toEqual([]);
    expect(snapshot.summary).toBe("0 requests · 0 tokens · $0.00 used");
    expect(snapshot.plan).toBe("Unmetered proxy key");
  });

  it("does not expose an upstream error body", async () => {
    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        timeoutMs: 5000,
        fetchFn: vi.fn(
          async () => new Response("secret details", { status: 403 }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("ClawRouter usage request failed (HTTP 403)");
  });

  it("bounds oversized usage JSON responses and closes the stream early", async () => {
    const oversized = createOversizedUsageServer();
    const port = await listenLoopbackServer(oversized.server);
    stops.push(async () => {
      oversized.server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        oversized.server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 5000,
        fetchFn: fetch,
      }),
    ).rejects.toThrow("clawrouter.usage: JSON response exceeds 16777216 bytes");

    const sentBytes = await oversized.closed;
    expect(sentBytes).toBeLessThan(OVERSIZED_RESPONSE_BYTES);
  });
});
