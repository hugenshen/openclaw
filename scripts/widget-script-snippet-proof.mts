import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
// Shipped Gateway proof: show_widget syntax errors keep emoji whole at the 160-unit line cap.
// Run: node --import ./scripts/tsx.mjs scripts/widget-script-snippet-proof.mts
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const LINE_PREFIX = `<script>${"a".repeat(151)}`;
const WIDGET_CODE = `${LINE_PREFIX}😀 const =</script>`;

type StartedGateway = {
  startupSettled: Promise<void>;
  close: () => Promise<void>;
};

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function readInvokeError(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") {
    throw new Error("tools.invoke did not return a tool error message");
  }
  return value.error.message;
}

function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : undefined;
      server.close((error) => {
        if (error || port === undefined) {
          reject(error ?? new Error("loopback port was not reserved"));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main(): Promise<void> {
  if (LINE_PREFIX.length !== 159) {
    throw new Error("widget line prefix must place the emoji on the snippet boundary");
  }
  const token = randomUUID();
  const port = await reserveLoopbackPort();
  const identityDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-widget-snippet-proof-"));
  const state = await createOpenClawTestState({
    label: "widget-script-snippet-proof",
    layout: "home",
    applyEnv: true,
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_LOG_LEVEL: "silent",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    },
  });
  let server: StartedGateway | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    await state.writeConfig({
      agents: { entries: { main: {} } },
      gateway: {
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      hooks: { enabled: false },
    });
    const { startGatewayServer } = await import("../src/gateway/server.js");
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    await server.startupSettled;
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ["operator.admin"],
      caps: ["inline-widgets"],
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: path.join(identityDir, "device.sqlite"),
      }),
      requestTimeoutMs: 20_000,
      timeoutMs: 30_000,
    });
    const message = readInvokeError(
      await client.request("tools.invoke", {
        name: "show_widget",
        args: { title: "Broken widget", widget_code: WIDGET_CODE },
      }),
    );
    const keptBoundary = message.includes(LINE_PREFIX) && !message.includes(`${LINE_PREFIX}\uD83D`);
    const wellFormed = !hasLoneSurrogate(message);
    console.log(
      `[widget-script snippet proof] well_formed=${String(wellFormed)} kept_boundary=${String(keptBoundary)} message_chars=${message.length}`,
    );
    if (!wellFormed || !keptBoundary) {
      throw new Error("show_widget syntax error split an emoji at the snippet cap");
    }
  } catch (error) {
    console.error(
      `[widget-script snippet proof] failed ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    if (client) {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
    await server?.close().catch(() => undefined);
    await state.cleanup().catch(() => undefined);
    await rm(identityDir, { recursive: true, force: true });
  }
}

await main();
