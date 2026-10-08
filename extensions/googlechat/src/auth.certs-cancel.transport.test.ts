// Proof: verifyGoogleChatRequest → fetchChatCerts through the REAL
// fetchWithSsrFGuard. Only the destination origin is rewritten onto loopback so
// the production guard, timeout, and cert-fetch owner still run. The 503
// headers are flushed while the body never completes; production must cancel
// that unread stream and close the server socket.
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const CHAT_CERTS_ORIGIN = "https://www.googleapis.com";
const CHAT_CERTS_PATH = "/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const loopback = vi.hoisted(() => ({ baseUrl: "" }));

const mockVerifySignedJwt = vi.hoisted(() => vi.fn());
const mockOAuth2Client = vi.hoisted(() =>
  vi.fn(function (this: { verifySignedJwtWithCertsAsync: typeof mockVerifySignedJwt }) {
    this.verifySignedJwtWithCertsAsync = mockVerifySignedJwt;
  }),
);

vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({ OAuth2Client: mockOAuth2Client }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      if (!loopback.baseUrl || new URL(params.url).origin !== CHAT_CERTS_ORIGIN) {
        throw new Error(`Unexpected Google Chat certs request: ${params.url}`);
      }
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace(CHAT_CERTS_ORIGIN, loopback.baseUrl),
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

import { verifyGoogleChatRequest } from "./auth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

describe("googlechat cert fetch non-OK hanging-body transport", () => {
  it("cancels the unread 503 certs stream and closes the loopback socket", async () => {
    const sockets = new Set<Socket>();
    let requestPath = "";
    const server = createServer((req, res) => {
      requestPath = req.url ?? "";
      res.writeHead(503, {
        "Content-Type": "text/plain",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const port = await listenOnLoopback(server);
    loopback.baseUrl = `http://127.0.0.1:${port}`;
    const started = Date.now();

    try {
      const outcome = await verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "12345",
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("Failed to fetch Chat certs (503)");
      expect(requestPath).toBe(CHAT_CERTS_PATH);
      expect(mockVerifySignedJwt).not.toHaveBeenCalled();
      await expect.poll(() => sockets.size === 0).toBe(true);
      const elapsedMs = Date.now() - started;
      console.log(
        `[googlechat certs 503 transport proof] reason=${outcome.reason} socket_closed=true elapsed_ms=${elapsedMs}`,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
