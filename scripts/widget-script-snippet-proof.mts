#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
/**
 * Shipped Gateway proof: show_widget syntax errors keep emoji whole at the
 * 160-unit line cap.
 * Run: node --import ./scripts/tsx.mjs scripts/widget-script-snippet-proof.mts
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { createOpenClawTestInstance } from "../test/helpers/openclaw-test-instance.ts";

const LINE_PREFIX = `<script>${"a".repeat(151)}`;
const WIDGET_CODE = `${LINE_PREFIX}😀 const =</script>`;

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

async function main(): Promise<void> {
  if (LINE_PREFIX.length !== 159) {
    throw new Error("widget line prefix must place the emoji on the snippet boundary");
  }
  const identityDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-snippet-proof-"));
  const instance = await createOpenClawTestInstance({
    name: "widget-script-snippet-proof",
    cwd: process.cwd(),
    startTimeoutMs: 180_000,
    gatewayToken: `widget-snippet-${randomUUID()}`,
    config: {
      update: { checkOnStart: false },
      gateway: { controlUi: { enabled: false } },
      plugins: { allow: [], slots: { memory: "none" } },
      hooks: { enabled: false },
      agents: { entries: { main: {} } },
    },
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_LOG_LEVEL: "silent",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
    },
  });
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    try {
      await instance.startGateway();
    } catch (error) {
      console.error(instance.logs());
      console.error(await instance.diagnose().catch((cause: unknown) => String(cause)));
      throw error;
    }
    if (!instance.child?.pid) {
      throw new Error("expected a shipped gateway child");
    }
    client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
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
    console.log(`[widget-script snippet proof] message=${JSON.stringify(message)}`);
    console.log(
      `[widget-script snippet proof] pid=${instance.child.pid} well_formed=${String(wellFormed)} kept_boundary=${String(keptBoundary)} message_chars=${message.length}`,
    );
    if (!wellFormed || !keptBoundary) {
      throw new Error("show_widget syntax error split an emoji at the snippet cap");
    }
  } finally {
    if (client) {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
    await instance.stopGateway().catch(() => undefined);
    await instance.cleanup().catch(() => undefined);
    await rm(identityDir, { recursive: true, force: true });
  }
}

await main();
