#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
/**
 * Shipped Gateway proof: code-mode syntax errors keep astral identifiers whole
 * at the 240-unit diagnostic cap.
 * Run: node --import ./scripts/tsx.mjs scripts/code-mode-syntax-proof.mts
 */
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeOpenAiResponsesSse } from "../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../test/helpers/openclaw-test-instance.ts";

const PROVIDER = "utf16-code-mode";
const MODEL = "syntax";
const MODEL_REF = `${PROVIDER}/${MODEL}`;
const NAME_PREFIX = "a".repeat(227);
const ASTRAL = "\u{1D400}";
const CODE = `const ${NAME_PREFIX}${ASTRAL} = 1; const ${NAME_PREFIX}${ASTRAL} = 2;`;

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

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, out);
    }
  }
}

/** The next model request echoes the guest source, which still contains the astral pair. */
function diagnosticMessages(rawBodies: readonly string[]): string[] {
  const messages: string[] = [];
  const pattern =
    /SyntaxError at openclaw-code-mode:user\.js:\d+:\d+: (.*?)\. No tools were dispatched/gsu;
  for (const raw of rawBodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const strings: string[] = [];
    collectStrings(parsed, strings);
    for (const text of strings) {
      for (const match of text.matchAll(pattern)) {
        if (match[1]) {
          messages.push(match[1]);
        }
      }
    }
  }
  return messages;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function writeToolCall(response: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_syntax",
    call_id: "call_syntax",
    name: "exec",
    arguments: JSON.stringify({ title: "syntax boundary", code: CODE }),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_syntax",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function writeFinal(response: ServerResponse): void {
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_done",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function main(): Promise<void> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      if (bodies.length === 1) {
        writeToolCall(response);
        return;
      }
      writeFinal(response);
    })().catch((error: unknown) => {
      console.error("[code-mode syntax proof] model server error", error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string", "model server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-code-mode-syntax-"));
  const workspace = path.join(fixtureDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "code-mode syntax proof\n");
  const instance = await createOpenClawTestInstance({
    name: "code-mode-syntax-proof",
    cwd: process.cwd(),
    startTimeoutMs: 180_000,
    config: {
      update: { checkOnStart: false },
      gateway: { controlUi: { enabled: false } },
      plugins: { allow: [], slots: { memory: "none" } },
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
          skills: [],
          model: { primary: MODEL_REF },
          models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { model: { primary: MODEL_REF } } },
      },
      tools: { codeMode: true, toolSearch: false },
      models: {
        mode: "replace",
        providers: {
          [PROVIDER]: {
            baseUrl: `${baseUrl}/v1`,
            apiKey: "test-token-placeholder",
            api: "openai-responses",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: MODEL,
                name: MODEL,
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    },
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_LOG_LEVEL: "silent",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      VITEST: undefined,
    },
  });
  try {
    try {
      await instance.startGateway();
    } catch (error) {
      console.error(instance.logs());
      console.error(await instance.diagnose().catch((cause: unknown) => String(cause)));
      throw error;
    }
    assert(instance.child?.pid, "expected a shipped gateway child");
    const rendered = await instance.cli(
      ["agent", "--message", "Check the guest JavaScript.", "--json"],
      { timeoutMs: 180_000 },
    );
    const diagnostics = diagnosticMessages(bodies);
    const diagnostic = diagnostics.join("\n");
    const keptBoundary =
      diagnostic.includes(NAME_PREFIX) &&
      !diagnostic.includes("\uD835") &&
      !diagnostic.includes(ASTRAL);
    const wellFormed = diagnostics.length > 0 && !hasLoneSurrogate(diagnostic);
    console.log(
      `[code-mode syntax proof] pid=${instance.child.pid} exit=${String(rendered.code)} requests=${bodies.length} diagnostics=${diagnostics.length} well_formed=${String(wellFormed)} kept_boundary=${String(keptBoundary)}`,
    );
    if (!wellFormed || !keptBoundary) {
      throw new Error(
        `code-mode diagnostic did not keep the identifier whole\n${rendered.stderr.slice(0, 1500)}\n${diagnostic.slice(0, 500)}`,
      );
    }
  } finally {
    await instance.stopGateway().catch(() => undefined);
    await instance.cleanup().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

await main();
