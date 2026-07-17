// Prove Urbit channel PUT pokes abort when headers or error bodies stall.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { pokeUrbitChannel } from "./channel-ops.js";

const STALL_TIMEOUT_MS = 80;
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe("pokeUrbitChannel request timeout", () => {
  let server: http.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("aborts when channel PUT stalls before response headers", async () => {
    server = http.createServer((_req, res) => {
      // Never write headers; leave the socket open until the client aborts.
      void res;
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const err = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        ship: "zod",
        channelId: "stall-headers",
        timeoutMs: STALL_TIMEOUT_MS,
        ssrfPolicy: { allowPrivateNetwork: true },
        lookupFn: lookupLoopback,
      },
      { app: "chat", mark: "chat-action", json: {}, auditContext: "test-headers-stall" },
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("aborts when an error response body stalls after headers", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "1048576" });
      // Headers sent; body never completes. Request AbortSignal must still cancel.
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const err = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        ship: "zod",
        channelId: "stall-body",
        timeoutMs: STALL_TIMEOUT_MS,
        ssrfPolicy: { allowPrivateNetwork: true },
        lookupFn: lookupLoopback,
      },
      { app: "chat", mark: "chat-action", json: {}, auditContext: "test-body-stall" },
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  // Compatibility proof: a real ship that just answers slowly (well within the
  // budget) must still succeed; the timeout must only fail requests that
  // actually overrun the budget, not merely "slow" ones.
  it("does not kill a poke that is slow but completes within the timeout budget", async () => {
    const budgetMs = 300;
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(204);
        res.end();
      }, budgetMs / 2);
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const pokeId = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        ship: "zod",
        channelId: "slow-success",
        timeoutMs: budgetMs,
        ssrfPolicy: { allowPrivateNetwork: true },
        lookupFn: lookupLoopback,
      },
      { app: "chat", mark: "chat-action", json: {}, auditContext: "test-slow-success" },
    );

    expect(typeof pokeId).toBe("number");
    expect(Date.now() - startedAt).toBeLessThan(budgetMs);
  });

  // Compatibility proof: the timeout is a true wall-clock cap on the whole
  // poke, not merely a per-chunk idle timer. A body that trickles in chunks
  // small enough to never trip the idle bound, but whose total time exceeds
  // the budget, must still be aborted at (approximately) the budget.
  it("aborts a trickling error body once total elapsed time exceeds the budget, even though every gap stays under the idle bound", async () => {
    const budgetMs = 300;
    const chunkGapMs = 80; // each gap < budgetMs (idle-safe) but 6 gaps > budgetMs overall.
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      const writeNext = () => {
        res.write("x");
        setTimeout(writeNext, chunkGapMs);
      };
      writeNext();
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const err = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        ship: "zod",
        channelId: "trickle-past-budget",
        timeoutMs: budgetMs,
        ssrfPolicy: { allowPrivateNetwork: true },
        lookupFn: lookupLoopback,
      },
      { app: "chat", mark: "chat-action", json: {}, auditContext: "test-trickle-past-budget" },
    ).catch((error: unknown) => error);

    const elapsedMs = Date.now() - startedAt;
    expect(err).toBeInstanceOf(Error);
    expect(elapsedMs).toBeLessThan(budgetMs + 1_000);
  });
});
