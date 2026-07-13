// Browser tests cover control-client timeoutMs forwarding into fetchWithSsrFGuard.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

const { fetchBrowserJson } = await import("./client-fetch.js");

describe("fetchBrowserJson timeoutMs floor", () => {
  beforeEach(() => {
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards the resolved timeoutMs into fetchWithSsrFGuard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: "http://127.0.0.1:18791/ok",
      release: async () => {},
    });

    await fetchBrowserJson("http://127.0.0.1:18791/ok", { timeoutMs: 1_500 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      url: "http://127.0.0.1:18791/ok",
      timeoutMs: 1_500,
      auditContext: "browser-control-client",
      policy: { allowPrivateNetwork: true },
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards the default 5s budget when callers omit timeoutMs", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: "http://127.0.0.1:18791/ok",
      release: async () => {},
    });

    await fetchBrowserJson("http://127.0.0.1:18791/ok");

    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 5_000 });
  });

  it("fails closed on a hung control peer via guarded timeoutMs floor", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    // Accept TCP but never write headers so missing dispatcher floors hang.
    const server = http.createServer((_req, _res) => {});
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/hung`;

    try {
      let observedTimeoutMs: number | undefined;
      fetchWithSsrFGuardMock.mockImplementationOnce(async (params) => {
        observedTimeoutMs = params.timeoutMs;
        // Production passes the resolved budget; prove the guarded dispatcher
        // path with a short stand-in so the hang fails far below OS timeouts.
        return await actual.fetchWithSsrFGuard({
          ...params,
          timeoutMs: 80,
        });
      });

      const started = Date.now();
      const error = await fetchBrowserJson(url, { timeoutMs: 1_500 }).catch(
        (cause: unknown) => cause,
      );
      const elapsedMs = Date.now() - started;

      expect(observedTimeoutMs).toBe(1_500);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out|timeout|aborted|Can't reach/i);
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
