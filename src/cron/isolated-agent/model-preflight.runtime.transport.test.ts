// Real-transport proof: cron local-provider preflight is status-only and must
// cancel unread response bodies so undici releases the TCP socket promptly.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("preflightCronModelProvider transport body cleanup", () => {
  beforeEach(() => {
    resetCronModelProviderPreflightCacheForTest();
  });

  afterEach(() => {
    resetCronModelProviderPreflightCacheForTest();
  });

  it("cancels unread local /models probe bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      // Keep the body open: status-only preflight must cancel rather than wait
      // for natural completion, or the connection stays pinned.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"models":[');
    });

    const baseUrl = await listen(server);
    try {
      const result = await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              vllm: {
                api: "openai-completions",
                baseUrl: `${baseUrl}/v1`,
                models: [],
              },
            },
          },
        },
        provider: "vllm",
        model: "llama",
      });

      expect(result).toEqual({ status: "available" });
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels unread local Ollama /api/tags probe bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"models":[');
    });

    const baseUrl = await listen(server);
    try {
      const result = await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                baseUrl,
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        model: "qwen3:32b",
      });

      expect(result).toEqual({ status: "available" });
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
