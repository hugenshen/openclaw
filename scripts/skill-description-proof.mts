#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
/**
 * Shipped Gateway proof: skills.list keeps an emoji whole at the 512-unit
 * description cap.
 * Run: node --import ./scripts/tsx.mjs scripts/skill-description-proof.mts
 */
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeOpenAiResponsesSse } from "../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../test/helpers/openclaw-test-instance.ts";

const PROVIDER = "utf16-skill-description";
const MODEL = "skills";
const MODEL_REF = `${PROVIDER}/${MODEL}`;
const PREFIX = "a".repeat(511);
const EMOJI = "😀";
const DESCRIPTION = `${PREFIX}${EMOJI}tail`;
const CODE = "return await skills.list(0);";

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

function collectSkillDescriptions(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectSkillDescriptions(JSON.parse(trimmed), out);
      } catch {
        // A tool transcript can mention the skill name without being JSON.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSkillDescriptions(item, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.name === "boundary-guide" && typeof record.description === "string") {
      out.push(record.description);
    }
    for (const item of Object.values(record)) {
      collectSkillDescriptions(item, out);
    }
  }
}

function skillDescriptions(rawBodies: readonly string[]): string[] {
  const descriptions: string[] = [];
  for (const raw of rawBodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const outputs: unknown[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
        return;
      }
      if (value === null || typeof value !== "object") {
        return;
      }
      const record = value as Record<string, unknown>;
      if (record.type === "function_call_output") {
        outputs.push(record.output);
      }
      for (const item of Object.values(record)) {
        visit(item);
      }
    };
    visit(parsed);
    for (const output of outputs) {
      collectSkillDescriptions(output, descriptions);
    }
  }
  return descriptions;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function writeToolCall(response: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_skills",
    call_id: "call_skills",
    name: "exec",
    arguments: JSON.stringify({ title: "list skills", code: CODE }),
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
        id: "resp_skills",
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
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      if (bodies.length === 1) {
        writeToolCall(response);
        return;
      }
      writeFinal(response);
    })().catch((error: unknown) => {
      console.error("[skill description proof] model server error", error);
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
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-skill-description-"));
  const workspace = path.join(fixtureDir, "workspace");
  const skillDir = path.join(workspace, "skills", "boundary-guide");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "skill description proof\n");
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: boundary-guide\ndescription: ${DESCRIPTION}\n---\nUse the boundary guide.\n`,
  );
  const instance = await createOpenClawTestInstance({
    name: "skill-description-proof",
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
      ["agent", "--message", "List installed skills.", "--json"],
      {
        timeoutMs: 180_000,
      },
    );
    const descriptions = skillDescriptions(bodies);
    const description = descriptions.find((value) => value.includes(PREFIX.slice(0, 40))) ?? "";
    const keptBoundary =
      description === PREFIX && !description.includes("\uD83D") && !description.includes(EMOJI);
    const wellFormed = description.length > 0 && !hasLoneSurrogate(description);
    console.log(
      `[skill description proof] pid=${instance.child.pid} exit=${String(rendered.code)} requests=${bodies.length} descriptions=${descriptions.length} well_formed=${String(wellFormed)} kept_boundary=${String(keptBoundary)}`,
    );
    if (!wellFormed || !keptBoundary) {
      throw new Error(
        `skills.list did not keep the description whole\n${rendered.stderr.slice(0, 1500)}\n${descriptions.join("\n").slice(0, 800)}`,
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
