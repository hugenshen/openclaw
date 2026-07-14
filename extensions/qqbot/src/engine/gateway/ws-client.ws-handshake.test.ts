// Deterministic handshakeTimeout wiring coverage for QQBot gateway client.
// Kept separate from ws-client.test.ts so that file's `vi.mock("ws")` does not apply.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("createQQWSClient websocket handshakeTimeout", () => {
  it("uses a 30s handshakeTimeout matching Slack relay / Mattermost", async () => {
    const source = await readFile(new URL("./ws-client.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000/);
    expect(source).toMatch(/handshakeTimeout: QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS/);
  });
});
