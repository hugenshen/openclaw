// Memory Host SDK tests cover remote http behavior.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchHostedRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import {
  MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS,
  withHostedRemoteHttpResponse,
  withRemoteHttpResponse,
} from "./remote-http.js";

/** Matches the package-private local/self-hosted hang floor in remote-http.ts. */
const MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS = 600_000;

describe("package withRemoteHttpResponse", () => {
  function makeFetchDeps({ useEnvProxy = false }: { useEnvProxy?: boolean } = {}) {
    const calls: unknown[] = [];
    return {
      calls,
      fetchWithSsrFGuardImpl: async (params: unknown) => {
        calls.push(params);
        return {
          response: new Response("ok", { status: 200 }),
          finalUrl: "https://memory.example/v1",
          release: async () => {},
        };
      },
      shouldUseEnvHttpProxyForUrlImpl: () => useEnvProxy,
    };
  }

  async function listenHungServer(): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    // Accept the socket but never write headers so missing timeouts hang forever.
    const server = http.createServer((_req, _res) => {});
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/v1/embeddings`,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };
  }

  it("defaults the hang floor to the local/self-hosted 600s embedding budget", async () => {
    expect(MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS).toBe(600_000);
    expect(MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS).toBe(120_000);

    const deps = makeFetchDeps();
    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS);
  });

  it("accepts the hosted 120s embedding budget as an explicit override", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      timeoutMs: MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS);
  });

  it("defaults the hosted wrapper to the 120s hosted hang floor", async () => {
    const deps = makeFetchDeps();

    await withHostedRemoteHttpResponse({
      url: "https://api.openai.com/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS);
  });

  it("uses trusted env proxy mode when the target will use EnvHttpProxyAgent", async () => {
    const deps = makeFetchDeps({ useEnvProxy: true });

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("url", "https://memory.example/v1/embeddings");
    expect(deps.calls[0]).toHaveProperty("mode", "trusted_env_proxy");
    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS);
  });

  it("keeps strict guarded fetch mode when proxy env would not proxy the target", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://internal.corp.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).not.toHaveProperty("mode");
    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS);
  });

  it("composes abort signals with the default hang floor", async () => {
    const deps = makeFetchDeps();
    const controller = new AbortController();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      signal: controller.signal,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("signal", controller.signal);
    expect(deps.calls[0]).toHaveProperty("timeoutMs", MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS);
  });

  it("honours an explicit timeoutMs override", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      timeoutMs: 1_500,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("timeoutMs", 1_500);
  });

  it("honours an explicit timeoutMs override even when a caller signal is present", async () => {
    const deps = makeFetchDeps();
    const controller = new AbortController();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      signal: controller.signal,
      timeoutMs: 1_500,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("signal", controller.signal);
    expect(deps.calls[0]).toHaveProperty("timeoutMs", 1_500);
  });

  it("times out hung remote responses when caller omits signal", async () => {
    const hung = await listenHungServer();
    try {
      const outcome = await withRemoteHttpResponse({
        url: hung.url,
        timeoutMs: 80,
        ssrfPolicy: { allowPrivateNetwork: true },
        onResponse: async () => "should-not-resolve",
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
      }
    } finally {
      await hung.close();
    }
  });

  it("times out hung remote responses when caller supplies a cancellation-only signal", async () => {
    const hung = await listenHungServer();
    const controller = new AbortController();
    try {
      const outcome = await withRemoteHttpResponse({
        url: hung.url,
        signal: controller.signal,
        timeoutMs: 80,
        ssrfPolicy: { allowPrivateNetwork: true },
        onResponse: async () => "should-not-resolve",
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
      }
    } finally {
      await hung.close();
    }
  });

  it("times out hung POST bodies shaped like postJson callers", async () => {
    const hung = await listenHungServer();
    try {
      // Same request shape as postJson → withRemoteHttpResponse (embedding providers).
      const outcome = await withRemoteHttpResponse({
        url: hung.url,
        timeoutMs: 80,
        ssrfPolicy: { allowPrivateNetwork: true },
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: ["proof"] }),
        },
        onResponse: async () => "should-not-resolve",
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
      }
    } finally {
      await hung.close();
    }
  });

  it("times out hung hosted wrapper requests used by OpenAI/Voyage/Google callers", async () => {
    const hung = await listenHungServer();
    try {
      const outcome = await withHostedRemoteHttpResponse({
        url: hung.url,
        timeoutMs: 80,
        ssrfPolicy: { allowPrivateNetwork: true },
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "text-embedding-3-small", input: ["proof"] }),
        },
        onResponse: async () => "should-not-resolve",
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
      }
    } finally {
      await hung.close();
    }
  });

  it("times out hung OpenAI/Voyage production embedding fetches via fetchHostedRemoteEmbeddingVectors", async () => {
    const hung = await listenHungServer();
    try {
      // Canonical hosted provider path: openai/voyage embedding-provider → this helper → postJson.
      const outcome = await fetchHostedRemoteEmbeddingVectors({
        url: hung.url,
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        timeoutMs: 80,
        ssrfPolicy: { allowPrivateNetwork: true },
        body: { model: "text-embedding-3-small", input: ["proof"] },
        errorPrefix: "openai embeddings failed",
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
      }
    } finally {
      await hung.close();
    }
  });
});
