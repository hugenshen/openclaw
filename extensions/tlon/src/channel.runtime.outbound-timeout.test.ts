// Caller-path proof: outbound sendText routes through pokeUrbitChannel (30s budget).
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const pokeUrbitChannel = vi.hoisted(() => vi.fn());
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(async () => "urbauth-~zod=test; Path=/; HttpOnly"),
}));

vi.mock("./urbit/channel-ops.js", async () => {
  const actual =
    await vi.importActual<typeof import("./urbit/channel-ops.js")>("./urbit/channel-ops.js");
  return {
    ...actual,
    pokeUrbitChannel: pokeUrbitChannel.mockImplementation(
      (deps: Parameters<typeof actual.pokeUrbitChannel>[0], params) =>
        actual.pokeUrbitChannel(
          {
            ...deps,
            timeoutMs: 80,
            ssrfPolicy: { allowPrivateNetwork: true },
            lookupFn: lookupLoopback,
          },
          params,
        ),
    ),
  };
});

const { tlonRuntimeOutbound } = await import("./channel.runtime.js");

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe("tlonRuntimeOutbound poke timeout", () => {
  let server: http.Server;

  afterEach(async () => {
    pokeUrbitChannel.mockClear();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("sendText uses pokeUrbitChannel and aborts when PUT never returns headers", async () => {
    server = http.createServer((_req, res) => {
      void res;
    });
    const port = await listen(server);
    const cfg = {
      channels: {
        tlon: {
          ship: "~zod",
          code: "lidlut-tabwed-pillex-ridrup",
          url: `http://127.0.0.1:${port}`,
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    } as OpenClawConfig;

    const startedAt = Date.now();
    await expect(
      tlonRuntimeOutbound.sendText!({
        cfg,
        to: "~sampel-palnet",
        text: "hello",
      } as Parameters<NonNullable<typeof tlonRuntimeOutbound.sendText>>[0]),
    ).rejects.toBeInstanceOf(Error);

    expect(pokeUrbitChannel).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
