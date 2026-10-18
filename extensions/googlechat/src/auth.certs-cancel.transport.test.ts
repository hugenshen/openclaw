// Proof: fetchChatCerts cancels an unread non-2xx body before release.
//
// A real loopback 503 returns headers with a declared Content-Length, then
// never finishes the body. A debug-capture-style tee keeps reading the clone.
// Awaiting body.cancel() deadlocks against that tee; the production contract is
// void-cancel-before-release (same as withGoogleChatResponse).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
const CHAT_CERTS_PATH = "/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
}));

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
      if (!loopback.baseUrl || params.url !== CHAT_CERTS_URL) {
        throw new Error("Unexpected request in Google Chat cert-cancel fixture");
      }
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        url: `${loopback.baseUrl}${CHAT_CERTS_PATH}`,
        policy: { allowPrivateNetwork: true },
      });

      // Debug-proxy capture tees a response and can leave its clone reading.
      // Awaiting cancellation of the other branch deadlocks without a prior
      // void cancel from fetchChatCerts.
      void guarded.response
        .clone()
        .arrayBuffer()
        .catch(() => undefined);

      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          // Reproduce the deadlock the sibling void-cancel-before-release
          // pattern prevents: awaiting cancel against an active capture tee.
          if (!guarded.response.bodyUsed) {
            await guarded.response.body?.cancel().catch(() => undefined);
          }
          await guarded.release();
        },
      };
    },
  };
});

import { verifyGoogleChatRequest } from "./auth.js";

async function listen(server: Server): Promise<string> {
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await withinDeadline(closed);
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Google Chat cert-cancel proof timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("Google Chat cert-fetch body cancel", () => {
  beforeEach(() => {
    loopback.baseUrl = "";
    loopback.releases = [];
    mockVerifySignedJwt.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("void-cancels a non-2xx hanging cert body before release against a capture tee", async () => {
    let socketClosed = false;
    let receivedPath: string | undefined;
    const server = createServer((request, response) => {
      receivedPath = request.url;
      request.resume();
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(503, {
        "Content-Type": "text/plain",
        "Content-Length": "100",
      });
      // Headers land; body never completes. Only an explicit cancel closes this.
      response.write("unavailable");
    });

    loopback.baseUrl = await listen(server);
    try {
      const outcome = await withinDeadline(
        verifyGoogleChatRequest({
          bearer: "token",
          audienceType: "project-number",
          audience: "12345",
        }),
      );
      expect(outcome).toEqual({
        ok: false,
        reason: "Failed to fetch Chat certs (503)",
      });
      expect(receivedPath).toBe(CHAT_CERTS_PATH);
      expect(mockVerifySignedJwt).not.toHaveBeenCalled();
      expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });
});
