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
});
