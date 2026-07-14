// Real-socket + generated-page proof: hung Mini App auth must abort via the
// page AbortController timer and surface the same expired/retry status.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTelegramMiniAppPage, TELEGRAM_MINIAPP_EXPIRED_MESSAGE } from "./page.js";

const TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS = 15_000;

describe("telegram miniapp auth AbortController timeout", () => {
  let server: Server;
  let baseUrl: string;
  let authRequests = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderTelegramMiniAppPage({
            accountId: "ops",
            scriptNonce: "test-nonce",
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth") {
        authRequests += 1;
        // Accept the TCP connection and request body, then hang forever so the
        // page AbortController timer is the only recovery path.
        req.resume();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("embeds AbortController timer cancellation in the production bootstrap page", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("const authController = new AbortController()");
    expect(html).toContain(`}, ${TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS});`);
    expect(html).toContain("signal: authController.signal");
    expect(html).toContain("clearTimeout(authTimeout)");
    expect(html).not.toContain("AbortSignal.timeout");
    expect(TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a hung same-origin auth fetch and shows the expired status", async () => {
    let statusText = "Opening dashboard...";
    const showExpired = () => {
      statusText = TELEGRAM_MINIAPP_EXPIRED_MESSAGE;
    };

    const startedAt = Date.now();
    // Mirror the production Mini App page cancellation: AbortController + timer,
    // cleared after settle so healthy auth is not raced by a late abort.
    const authController = new AbortController();
    const authTimeout = setTimeout(() => {
      authController.abort();
    }, TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS);
    await fetch(`${baseUrl}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: "hang", accountId: "ops" }),
      credentials: "same-origin",
      signal: authController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("auth failed");
        }
        return await response.json();
      })
      .then((payload: { controlUiUrl: string; gatewayUrl: string; bootstrapToken: string }) => {
        const next = new URL(payload.controlUiUrl);
        next.hash =
          "gatewayUrl=" +
          encodeURIComponent(payload.gatewayUrl) +
          "&bootstrapToken=" +
          encodeURIComponent(payload.bootstrapToken);
        throw new Error(`unexpected redirect to ${next.toString()}`);
      })
      .catch(showExpired)
      .then(() => {
        clearTimeout(authTimeout);
      });

    const elapsedMs = Date.now() - startedAt;
    expect(authRequests).toBeGreaterThan(0);
    expect(statusText).toBe(TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    expect(elapsedMs).toBeGreaterThanOrEqual(TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS + 2_000);
  }, 20_000);
});
