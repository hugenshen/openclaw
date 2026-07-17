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

  // Compatibility proof: a real ship that just answers slowly (well within the
  // budget) must still succeed. The timeout must only fail requests that
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
    const pokeId = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/slow-success",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: budgetMs,
      },
      { app: "chat", mark: "chat-action", json: {} },
    );

    expect(typeof pokeId).toBe("number");
    expect(Date.now() - startedAt).toBeLessThan(budgetMs);
  });

  // Compatibility proof: an error body that trickles in (each gap under the
  // idle bound) but finishes inside the overall budget must be read in full,
  // not treated as a stall just because it arrived in several small writes.
  it("reads a slow-trickling error body in full when it completes within the timeout budget", async () => {
    const budgetMs = 300;
    const chunkGapMs = 40;
    const chunks = ["boom", "-still", "-going", "-done"];
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      let index = 0;
      const writeNext = () => {
        if (index >= chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[index]);
        index += 1;
        setTimeout(writeNext, chunkGapMs);
      };
      writeNext();
    });
    const port = await listen(server);

    const err = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/slow-error-body",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: budgetMs,
      },
      { app: "chat", mark: "chat-action", json: {} },
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Poke failed: 500 - ${chunks.join("")}`);
  });

  // Compatibility proof: the timeout is a true wall-clock cap on the whole
  // poke, not merely a per-chunk idle timer. A body that trickles in chunks
  // small enough to never trip the idle bound, but whose total time exceeds
  // the budget, must still be aborted at (approximately) the budget, not
  // allowed to run past it.
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
    const err = await pokeTlonChannel(
      {
        url: `http://127.0.0.1:${port}`,
        cookie: "urbauth-~zod=test",
        channelPath: "/~/channel/trickle-past-budget",
        shipName: "zod",
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: budgetMs,
      },
      { app: "chat", mark: "chat-action", json: {} },
    ).catch((error: unknown) => error);

    const elapsedMs = Date.now() - startedAt;
    expect(err).toBeInstanceOf(Error);
    // Bounded by the overall budget (plus scheduling slack), not by however
    // long the trickle happened to keep going.
    expect(elapsedMs).toBeLessThan(budgetMs + 1_000);
  });
});
