// Real-transport proof: cron local-provider preflight is status-only and must
// cancel unread response bodies so undici releases the TCP socket promptly.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

const SOCKET_CLOSE_TIMEOUT_MS = 2_000;

const PROBE_CASES = [
  {
    name: "local /models",
    provider: "vllm",
    model: "llama",
    expectedPath: "/v1/models",
    providerConfig: (origin: string) => ({
      api: "openai-completions" as const,
      baseUrl: `${origin}/v1`,
      models: [],
    }),
  },
  {
    name: "local Ollama /api/tags",
    provider: "ollama",
    model: "qwen3:32b",
    expectedPath: "/api/tags",
    providerConfig: (origin: string) => ({
      api: "ollama" as const,
      baseUrl: origin,
      models: [],
    }),
  },
] as const;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

describe("preflightCronModelProvider transport body cleanup", () => {
  beforeEach(resetCronModelProviderPreflightCacheForTest);
  afterEach(resetCronModelProviderPreflightCacheForTest);

  it.each(PROBE_CASES)(
    "cancels unread $name probe bodies and closes the request socket",
    async ({ provider, model, expectedPath, providerConfig }) => {
      let requestPath: string | undefined;
      let resolveClientClosed: (() => void) | undefined;
      const clientClosed = new Promise<void>((resolve) => {
        resolveClientClosed = resolve;
      });
      const server = createServer((request, response) => {
        requestPath = request.url;
        request.socket.once("close", () => resolveClientClosed?.());
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"models":[');
      });

      const origin = await listen(server);
      try {
        const result = await preflightCronModelProvider({
          cfg: {
            models: {
              providers: {
                [provider]: providerConfig(origin),
              },
            },
          },
          provider,
          model,
        });

        expect(result).toEqual({ status: "available" });
        expect(requestPath).toBe(expectedPath);
        await withTestTimeout(
          clientClosed,
          SOCKET_CLOSE_TIMEOUT_MS,
          `timed out waiting for ${expectedPath} probe socket close`,
        );
      } finally {
        await closeServer(server);
      }
    },
  );
});
