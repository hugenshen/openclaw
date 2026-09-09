import { errorMonitor, once } from "node:events";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { RealtimeCallHandler } from "./webhook/realtime-handler.js";

vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: () => undefined,
  listRealtimeTranscriptionProviders: () => [
    {
      id: "fixture",
      label: "Fixture",
      isConfigured: () => true,
      createSession: (): never => {
        throw new Error("No transcription before a stream start");
      },
    } satisfies RealtimeTranscriptionProviderPlugin,
  ],
}));

function createServer(streaming = false) {
  const config = VoiceCallConfigSchema.parse({
    serve: { bind: "127.0.0.1", path: "/voice/webhook" },
    staleCallReaperSeconds: 0,
    streaming: { enabled: streaming, streamPath: "/voice/stream" },
    realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
  });
  config.serve.port = 0;
  const manager = new CallManager(config);
  const server = new VoiceCallWebhookServer(config, manager, new MockProvider());
  const resolveRegistration = vi.fn((): never => {
    throw new Error("Rejected upgrades must not acquire a provider");
  });
  server.setRealtimeHandler(
    new RealtimeCallHandler(
      config.realtime,
      manager,
      resolveRegistration,
      config.serve.path,
      server.getStreamDisconnectLifecycle(),
    ),
  );
  return { server, resolveRegistration };
}

function upgradeRequest(path: string) {
  return (
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\n` +
    "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
  );
}

describe("VoiceCallWebhookServer upgrade rejection", () => {
  it("flushes an unmatched upgrade's HTTP 404 before closing", async () => {
    const { server, resolveRegistration } = createServer();
    let client: net.Socket | undefined;
    try {
      const url = new URL(await server.start());
      client = net.connect({ host: url.hostname, port: Number(url.port) });
      const closed = once(client, "close");
      let response = "";
      client.setEncoding("utf8");
      client.on("data", (chunk) => {
        response += chunk;
      });
      await once(client, "connect");
      client.write(upgradeRequest("/not-a-voice-stream"));
      await closed;
      expect(response).toBe("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      expect(resolveRegistration).not.toHaveBeenCalled();
    } finally {
      client?.destroy();
      await server.stop();
    }
  });

  it("handles a server socket error while the unmatched rejection write is pending", async () => {
    const { server } = createServer();
    const pendingWrite = createDeferred<string>();
    const serverError = createDeferred<Error>();
    const serverClosed = createDeferred<void>();
    let rejectedSocket: Duplex | undefined;
    let releaseWrite: (() => void) | undefined;
    let client: net.Socket | undefined;
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => {
      uncaught.push(error);
    };
    process.on("uncaughtExceptionMonitor", onUncaught);
    const originalCreateServer = http.createServer.bind(http);
    const createServerSpy = vi.spyOn(http, "createServer").mockImplementation((...args) => {
      const created = originalCreateServer(...args);
      created.prependOnceListener("upgrade", (_request, socket) => {
        rejectedSocket = socket;
        // errorMonitor observes the fault without becoming the missing error guard.
        socket.once(errorMonitor, (error: Error) => serverError.resolve(error));
        socket.once("close", () => serverClosed.resolve());
        const writeSpy = vi
          .spyOn(socket, "_write")
          .mockImplementationOnce((chunk: Uint8Array | string, _encoding, callback) => {
            writeSpy.mockRestore();
            releaseWrite = () => callback();
            pendingWrite.resolve(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          });
      });
      return created;
    });
    try {
      const url = new URL(await server.start());
      client = net.connect({ host: url.hostname, port: Number(url.port) });
      client.on("error", () => {});
      await once(client, "connect");
      client.write(upgradeRequest("/not-a-voice-stream"));
      expect(await pendingWrite.promise).toBe(
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
      );
      if (!rejectedSocket) {
        throw new Error("No rejected server socket");
      }
      expect(rejectedSocket.destroyed).toBe(false);
      expect(rejectedSocket.writableFinished).toBe(false);
      expect(rejectedSocket.writableLength).toBeGreaterThan(0);
      const failure = Object.assign(new Error("synthetic rejection transport failure"), {
        code: "ECONNRESET",
      });
      rejectedSocket.destroy(failure);
      expect(await serverError.promise).toBe(failure);
      await serverClosed.promise;
      expect(uncaught).toEqual([]);
    } finally {
      rejectedSocket?.destroy();
      releaseWrite?.();
      client?.destroy();
      await server.stop();
      createServerSpy.mockRestore();
      process.off("uncaughtExceptionMonitor", onUncaught);
    }
  });

  it("leaves recognized realtime and media upgrades with their handlers", async () => {
    const { server, resolveRegistration } = createServer(true);
    try {
      const url = new URL(await server.start());
      for (const [path, status] of [
        ["/voice/stream/realtime/invalid", 401],
        ["/voice/stream", 101],
      ] as const) {
        const response = await new Promise<number | undefined>((resolve, reject) => {
          const request = http.request(new URL(path, url), {
            headers: {
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
          });
          request.on("response", (result) => {
            result.resume();
            resolve(result.statusCode);
          });
          request.on("upgrade", (result, socket) => {
            socket.destroy();
            resolve(result.statusCode);
          });
          request.on("error", reject);
          request.setTimeout(2_000, () => request.destroy(new Error("Upgrade timed out")));
          request.end();
        });
        expect(response).toBe(status);
      }
      expect(resolveRegistration).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
