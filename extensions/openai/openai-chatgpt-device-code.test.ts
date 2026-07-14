// Openai tests cover openai chatgpt device code plugin behavior.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAccessTokenExpiry } from "./openai-chatgpt-auth-identity.js";
import { loginOpenAICodexDeviceCode } from "./openai-chatgpt-device-code.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function createJsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function fetchCall(fetchMock: FetchMock, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

function hangingFetch(
  _input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }

    const abort = () => {
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createHangingFetch(): FetchMock {
  return vi.fn(hangingFetch);
}

function stubDeviceCodeFetchTimeout(expectedTimeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(expectedTimeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });
}

const originalAbortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);

function stubDeviceCodeFetchTimeoutAfterHeaders(expectedTimeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(expectedTimeoutMs);
    // Keep a short real timer so headers can return before the body stall
    // aborts; keep enough slack for cold loopback under load.
    return originalAbortSignalTimeout(120);
  });
}

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
      resolve(address.port);
    });
  });
}

async function startPartialBodyStallServer(): Promise<{
  origin: string;
  getRequestCount: () => number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let requestCount = 0;
  // Send headers + a partial JSON prefix, then stall so body consumption must
  // honor the same AbortSignal.timeout as the initial fetch.
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"partial":');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    getRequestCount: () => requestCount,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function createLoopbackFetchRedirect(origin: string): FetchMock {
  const realFetch = globalThis.fetch;
  return vi.fn(async (_input, init) => realFetch(origin, init));
}

describe("loginOpenAICodexDeviceCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("requests a device code, polls for authorization, and exchanges OAuth tokens", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_challenge: "ignored",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 600,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
            "https://api.openai.com/profile": {
              email: "codex@example.com",
            },
          }),
          refresh_token: "refresh-token-123",
          id_token: createJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
          }),
          expires_in: 600,
        }),
      );
    const onVerification = vi.fn(async () => {});
    const onProgress = vi.fn();

    const credentialsPromise = loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification,
      onProgress,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const credentials = await credentialsPromise;

    const userCodeRequest = fetchCall(fetchMock, 0);
    expect(userCodeRequest[0]).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(userCodeRequest[1]?.method).toBe("POST");
    expect(userCodeRequest[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(userCodeRequest[1]?.headers).toEqual({
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });

    const deviceTokenRequest = fetchCall(fetchMock, 1);
    expect(deviceTokenRequest[0]).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(deviceTokenRequest[1]?.method).toBe("POST");
    expect(deviceTokenRequest[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(deviceTokenRequest[1]?.headers).toEqual({
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });

    const oauthTokenRequest = fetchCall(fetchMock, 3);
    expect(oauthTokenRequest[0]).toBe("https://auth.openai.com/oauth/token");
    expect(oauthTokenRequest[1]?.method).toBe("POST");
    expect(oauthTokenRequest[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(oauthTokenRequest[1]?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(onVerification).toHaveBeenCalledWith({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-12345",
      expiresInMs: 900_000,
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, "Requesting device code…");
    expect(onProgress).toHaveBeenNthCalledWith(2, "Waiting for device authorization…");
    expect(onProgress).toHaveBeenNthCalledWith(3, "Exchanging device code…");
    expect(typeof credentials.access).toBe("string");
    expect(credentials.access.length).toBeGreaterThan(0);
    expect(credentials.refresh).toBe("refresh-token-123");
    expect(credentials).not.toHaveProperty("accountId");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it("aborts device-code polling without another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "5",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const login = loginOpenAICodexDeviceCode({
      fetchFn: fetchMock,
      onVerification: async () => {},
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    controller.abort(new Error("cancelled"));
    await expect(login).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight hung user-code request on caller cancel", async () => {
    const controller = new AbortController();
    const fetchMock = createHangingFetch();
    // Keep operation timeout effectively disabled so only caller cancel fires.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);

    const login = loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);

    controller.abort(new Error("cancelled"));
    await expect(login).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats JWT-derived expiry fallback as an absolute timestamp", async () => {
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const expectedExpiry = resolveCodexAccessTokenExpiry(accessToken);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token-123",
        }),
      );

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });

    if (expectedExpiry === undefined) {
      throw new Error("expected device-code expiry to be calculated");
    }
    expect(credentials.expires).toBe(expectedExpiry);
  });

  it("accepts token exchange JSON above the diagnostic preview limit", async () => {
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token-123",
          id_token: "x".repeat(10_000),
        }),
      );

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });

    expect(credentials.refresh).toBe("refresh-token-123");
  });

  it("falls back when device-code intervals and token lifetimes overflow safe milliseconds", async () => {
    vi.useFakeTimers();
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const expectedExpiry = resolveCodexAccessTokenExpiry(accessToken);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: Number.MAX_SAFE_INTEGER,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token-123",
          expires_in: Number.MAX_SAFE_INTEGER,
        }),
      );

    const credentialsPromise = loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const credentials = await credentialsPromise;

    if (expectedExpiry === undefined) {
      throw new Error("expected device-code expiry to be calculated");
    }
    expect(credentials.expires).toBe(expectedExpiry);
  });

  it("surfaces user-code request failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(`down\r\n\u001B[31mnow\u001B[0m`, {
        status: 503,
      }),
    );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device code request failed: HTTP 503 down now");
  });

  it("bounds user-code error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"device code unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi.fn().mockResolvedValueOnce(tracked.response);

    const error = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /OpenAI device code request failed: HTTP 503 device code unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("surfaces device authorization failures with sanitized payload details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: "authorization_declined\r\n\u001B[31mspoofed\u001B[0m",
            error_description: "Denied\r\nnext line",
          },
          { status: 401 },
        ),
      );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow(
      "OpenAI device authorization failed: authorization_declined spoofed (Denied next line)",
    );
  });

  it("strips C1 terminal controls from reflected device-code errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: `authorization_declined${String.fromCharCode(0x9b)}spoofed`,
            error_description: `Denied${String.fromCharCode(0x9d)}next line`,
          },
          { status: 401 },
        ),
      );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow(
      "OpenAI device authorization failed: authorization_declined spoofed (Denied next line)",
    );
  });

  it("aborts hung user-code requests instead of waiting forever", async () => {
    stubDeviceCodeFetchTimeout(30_000);
    const fetchMock = createHangingFetch();

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device code user code request timed out after 30000ms");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries device authorization polls after a per-request timeout", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
          refresh_token: "refresh-token-123",
          expires_in: 600,
        }),
      );

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });

    expect(credentials.refresh).toBe("refresh-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchCall(fetchMock, 1)[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchCall(fetchMock, 2)[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry authorization polls after caller cancel", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        queueMicrotask(() => controller.abort(new Error("cancelled")));
        return hangingFetch(_input, init);
      });

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts hung token exchange requests instead of waiting forever", async () => {
    let timeoutCall = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      timeoutCall += 1;
      if (timeoutCall < 3) {
        return originalAbortSignalTimeout(actualTimeoutMs);
      }
      expect(actualTimeoutMs).toBe(30_000);
      const controller = new AbortController();
      queueMicrotask(() => {
        controller.abort(new DOMException("timed out", "TimeoutError"));
      });
      return controller.signal;
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockImplementationOnce(hangingFetch);

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device code token exchange timed out after 30000ms");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchCall(fetchMock, 2)[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts when user-code headers arrive but the body never completes", async () => {
    const server = await startPartialBodyStallServer();
    stubDeviceCodeFetchTimeoutAfterHeaders(30_000);
    const fetchMock = createLoopbackFetchRedirect(server.origin);

    try {
      await expect(
        loginOpenAICodexDeviceCode({
          fetchFn: fetchMock as typeof fetch,
          onVerification: async () => {},
        }),
      ).rejects.toThrow("OpenAI device code user code request timed out after 30000ms");
      expect(server.getRequestCount()).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await server.close();
    }
  });

  it("cancels a post-header body stall on caller abort without mapping to timeout", async () => {
    const server = await startPartialBodyStallServer();
    const controller = new AbortController();
    // Keep operation timeout disabled so only caller cancel aborts the body.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const fetchMock = createLoopbackFetchRedirect(server.origin);

    try {
      const login = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
        signal: controller.signal,
      });
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(server.getRequestCount()).toBe(1);
      expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);

      controller.abort(new Error("cancelled"));
      await expect(login).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("cancelled");
        expect((error as Error).message).not.toMatch(/timed out after/);
        return true;
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("retries authorization polls after a post-header body stall", async () => {
    const server = await startPartialBodyStallServer();
    let timeoutCall = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      timeoutCall += 1;
      if (timeoutCall === 1) {
        // user-code request: keep the configured deadline
        return originalAbortSignalTimeout(actualTimeoutMs);
      }
      if (timeoutCall === 2) {
        // first poll: short real timeout so the partial body aborts under the
        // same operation signal after headers return
        expect(actualTimeoutMs).toBe(30_000);
        return originalAbortSignalTimeout(120);
      }
      return originalAbortSignalTimeout(actualTimeoutMs);
    });

    const realFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockImplementationOnce(async (_input, init) => realFetch(server.origin, init))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
          refresh_token: "refresh-token-123",
          expires_in: 600,
        }),
      );

    try {
      const credentials = await loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      });
      expect(credentials.refresh).toBe("refresh-token-123");
      expect(server.getRequestCount()).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      await server.close();
    }
  });

  it("aborts when token-exchange headers arrive but the body never completes", async () => {
    const server = await startPartialBodyStallServer();
    let timeoutCall = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      timeoutCall += 1;
      if (timeoutCall < 3) {
        return originalAbortSignalTimeout(actualTimeoutMs);
      }
      expect(actualTimeoutMs).toBe(30_000);
      return originalAbortSignalTimeout(120);
    });

    const realFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockImplementationOnce(async (_input, init) => realFetch(server.origin, init));

    try {
      await expect(
        loginOpenAICodexDeviceCode({
          fetchFn: fetchMock as typeof fetch,
          onVerification: async () => {},
        }),
      ).rejects.toThrow("OpenAI device code token exchange timed out after 30000ms");
      expect(server.getRequestCount()).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });
});
