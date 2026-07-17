// Prove the outbound poke PUT (the actual caller path used by sendText/sendMedia)
// aborts when headers or an error body stall, and still succeeds normally otherwise.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const STALL_TIMEOUT_MS = 80;

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(async () => "urbauth-~zod=test; Path=/; HttpOnly"),
}));

const { pokeTlonChannel } = await import("./channel.runtime.js");

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe("pokeTlonChannel request timeout (outbound sendText/sendMedia caller path)", () => {
  let server: http.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("aborts when the channel PUT never returns headers", async () => {
    server = http.createServer((_req, res) => {
      // Never write headers; leave the socket open until the client aborts.
      void res;
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const err = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/stall-headers",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: STALL_TIMEOUT_MS,
      },
      { app: "chat", mark: "chat-action", json: {} },
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("aborts when an error response body stalls after headers", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "1048576" });
      // Headers sent; body never completes. Idle-bounded read must still reject.
    });
    const port = await listen(server);

    const startedAt = Date.now();
    const err = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/stall-body",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: STALL_TIMEOUT_MS,
      },
      { app: "chat", mark: "chat-action", json: {} },
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("still returns the poke id on a normal 204 response", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const port = await listen(server);

    const pokeId = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/success",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: STALL_TIMEOUT_MS,
      },
      { app: "chat", mark: "chat-action", json: {} },
    );

    expect(typeof pokeId).toBe("number");
  });
});
