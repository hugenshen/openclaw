import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { canonicalBytes, fromBase64url, sha256Hex } from "../protocol/index.js";
import { ReefInboxConnection, ReefTransportClient, type WebSocketLike } from "./transport.js";
import type { ReefKeys } from "./types.js";

const ts = 1_752_300_000;
const signing = {
  secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
};
const keys: ReefKeys = {
  signing,
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

function verifyRelaySignature(
  signature: string,
  input: { method: string; path: string; ts: number; bodySha256: string },
): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(fromBase64url(signing.publicKey))]),
    format: "der",
    type: "spki",
  });
  return verifySignature(
    null,
    canonicalBytes(input),
    publicKey,
    Buffer.from(fromBase64url(signature)),
  );
}

describe("ReefTransportClient device authentication", () => {
  it("signs the relay canonical REST path including its query and emits auth headers", async () => {
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return Response.json({ entries: [], cursor: 5 });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await expect(client.pull(5)).resolves.toEqual({ entries: [], cursor: 5 });

    const [requestUrl, init] = calls[0]!;
    expect(requestUrl instanceof URL ? requestUrl.href : requestUrl).toBe(
      "https://relay.example/v1/mail?after=5",
    );
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-reef-handle")).toBe("alice");
    expect(headers.get("x-reef-ts")).toBe(String(ts));
    expect(headers.get("x-reef-sig")).toBe(
      "1Zx-WD8JygVzq8pdTWULPiEZyoLuoJ1zyokkDRGlPWu_6fAKxEfJHPZkCQaZ8DIS4LERDqeh2z6-qlw7BtcoDw",
    );

    const canonical = {
      method: "GET",
      path: "/v1/mail?after=5",
      ts,
      bodySha256: sha256Hex(new Uint8Array()),
    };
    expect(new TextDecoder().decode(canonicalBytes(canonical))).toBe(
      '{"bodySha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","method":"GET","path":"/v1/mail?after=5","ts":1752300000}',
    );
    expect(verifyRelaySignature(headers.get("x-reef-sig")!, canonical)).toBe(true);
  });

  it("puts WebSocket auth in the query but signs the bare relay path", () => {
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      vi.fn() as typeof fetch,
      () => ts,
    );
    const url = new URL(client.websocketUrl());

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/mail/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      handle: "alice",
      ts: String(ts),
      sig: "teC4QkpLUCMghGA-PkBGBMZFPxNeERmNfGCivaxpYhL8q81v6ReHRKEq2ZVvOd-FG3d3BbMjk-FcvoKjW5kwAA",
    });
    expect(
      verifyRelaySignature(url.searchParams.get("sig")!, {
        method: "GET",
        path: "/v1/mail/ws",
        ts,
        bodySha256: sha256Hex(new Uint8Array()),
      }),
    ).toBe(true);
  });

  it("bumps ts monotonically so identical same-second requests never share a replay key", async () => {
    const seenTs: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenTs.push(new Headers(init?.headers).get("x-reef-ts")!);
      return Response.json({ friendships: [] });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await client.listFriends();
    await client.listFriends();
    await client.listFriends();

    expect(seenTs).toEqual([String(ts), String(ts + 1), String(ts + 2)]);
    expect(new Set(seenTs).size).toBe(3);
  });
});

class HangWebSocket implements WebSocketLike {
  private readonly handlers = new Map<string, Array<(event?: { data: unknown }) => void>>();
  closed = false;

  addEventListener(
    type: "message" | "open" | "close" | "error",
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener as (event?: { data: unknown }) => void);
    this.handlers.set(type, list);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.handlers.get("close") ?? []) {
      listener();
    }
  }
}

describe("ReefInboxConnection open timeout", () => {
  it("uses a 30s open-wait floor because WHATWG WebSocket has no handshakeTimeout", async () => {
    const source = await readFile(new URL("./transport.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const REEF_INBOX_WEBSOCKET_OPEN_TIMEOUT_MS = 30_000/);
    expect(source).toMatch(/reef inbox websocket open timed out/);
    expect(source).toMatch(/clearTimeout\(openTimer\)/);
  });

  it("returns control to reconnect when the websocket never opens", async () => {
    // Missing open-wait would leave start() forever on await live().
    const sockets: HangWebSocket[] = [];
    const client = {
      pull: async () => ({ entries: [], cursor: 0 }),
      websocketUrl: () => "ws://reef.example/v1/mail/ws",
    } as unknown as ReefTransportClient;
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => {
        const socket = new HangWebSocket();
        sockets.push(socket);
        return socket;
      },
      undefined,
      40,
    );

    const started = inbox.start(abort.signal);
    await vi.waitFor(() => {
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    });
    expect(sockets[0]?.closed).toBe(true);
    abort.abort();
    await started;
    console.log(
      `[reef open-wait proof] timeout_then_reconnect=true socket_attempts=${sockets.length} openTimeout_ms=40`,
    );
  });

  it("fails open against a TCP peer that never completes the websocket upgrade", async () => {
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const client = {
      pull: async () => ({ entries: [], cursor: 0 }),
      websocketUrl: () => `ws://127.0.0.1:${port}`,
    } as unknown as ReefTransportClient;
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      (url) => new WebSocket(url) as unknown as WebSocketLike,
      undefined,
      200,
    );

    try {
      const startedAt = Date.now();
      const started = inbox.start(abort.signal);
      await vi.waitFor(
        () => {
          // First open timeout rejects live(); start() sleeps then retries drain+live.
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
        },
        { timeout: 2_000 },
      );
      // Give the reconnect loop one backoff tick, then stop.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      abort.abort();
      await started;
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(180);
      expect(elapsedMs).toBeLessThan(3_000);
      console.log(
        `[reef open-wait live proof] timed_out=true elapsed_ms=${elapsedMs} openTimeout_ms=200`,
      );
    } finally {
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }, 10_000);
});
