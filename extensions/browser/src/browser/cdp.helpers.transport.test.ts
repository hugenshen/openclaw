// Real-transport proof: CDP status-only probes must cancel unread bodies.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchCdpChecked, fetchOk } from "./cdp.helpers.js";

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

describe("cdp helpers transport body cleanup", () => {
  it("fetchOk cancels unread bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"Browser":"Chrome","webSocketDebuggerUrl":"ws://127.0.0.1/devtools');
    });

    const baseUrl = await listen(server);
    try {
      await expect(
        fetchOk(`${baseUrl}/json/version`, 2_000, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).resolves.toBeUndefined();
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fetchCdpChecked cancels unread bodies on non-OK status before throwing", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(503, { "Content-Type": "application/json" });
      response.write('{"error":"unavailable"');
    });

    const baseUrl = await listen(server);
    try {
      await expect(
        fetchCdpChecked(`${baseUrl}/json/version`, 2_000, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toThrow("HTTP 503");
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
