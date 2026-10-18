// Shipped Telegram delivery proof for retained subagent progress titles.
// Run: node --import ./scripts/tsx.mjs scripts/subagent-progress-title-proof.ts
//
// The parent records Bot API sendMessage/editMessageText bodies. The child
// calls retainProgressDraft, which is the production card owner, then
// adoptSubagentProgressDraft. streaming.progress.maxLineChars is 400 so the
// rendered "${title}: running" row keeps the 120-unit title. The default 120
// compacts that row and would hide a split surrogate.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOUNDARY_TITLE = "a".repeat(119);
const EXPECTED_ROW = `${BOUNDARY_TITLE}: running`;
const LINE_BUDGET = 400;
const API_TOKEN = "123456:progress-title-proof";

function requestText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function deliveredText(raw: string, contentType: string): string | undefined {
  if (contentType.includes("json")) {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && "text" in body) {
      const text = body.text;
      return typeof text === "string" ? text : undefined;
    }
    return undefined;
  }
  return new URLSearchParams(raw).get("text") ?? undefined;
}

function telegramOk(response: ServerResponse, text: string | undefined): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      result: {
        message_id: 42,
        date: 1_700_000_000,
        chat: { id: 123, type: "private" },
        ...(text === undefined ? {} : { text }),
      },
    }),
  );
}

async function recordDelivery(): Promise<void> {
  const deliveries: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await requestText(request);
      const method = request.url?.split("/").at(-1) ?? "";
      const text = deliveredText(raw, request.headers["content-type"] ?? "");
      if ((method === "sendMessage" || method === "editMessageText") && text) {
        deliveries.push(text);
      }
      telegramOk(response, text);
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end();
      console.error(error instanceof Error ? error.message : "loopback failed");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback listener did not bind");
  }
  const apiRoot = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "scripts/subagent-progress-title-proof.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PROGRESS_TITLE_PROOF_CHILD: "1",
        PROGRESS_TITLE_PROOF_API_ROOT: apiRoot,
      },
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  const text = deliveries.find((entry) => entry.includes(BOUNDARY_TITLE));
  const wellFormed = text?.isWellFormed() ?? false;
  const keptBoundary = text?.includes(EXPECTED_ROW) ?? false;
  console.log(
    `[subagent-progress title proof] deliveries=${deliveries.length} well_formed=${wellFormed} kept_boundary=${keptBoundary} line_budget=${LINE_BUDGET}`,
  );
  if (text) {
    console.log(`[subagent-progress title proof] text=${JSON.stringify(text)}`);
  }
  if (exitCode !== 0 || !text || !wellFormed || !keptBoundary) {
    throw new Error("retained Telegram card did not deliver the UTF-16-safe title");
  }
}

async function deliverRetainedCard(): Promise<void> {
  const apiRoot = process.env.PROGRESS_TITLE_PROOF_API_ROOT;
  if (!apiRoot) {
    throw new Error("missing loopback API root");
  }
  const { Bot } = await import("grammy");
  const { createTelegramDraftStream } = await import("../extensions/telegram/src/draft-stream.js");
  const { retainProgressDraft } =
    await import("../extensions/telegram/src/bot-message-dispatch-progress.js");
  const { createChannelProgressDraftCompositor } =
    await import("../src/channels/progress-draft-compositor.js");
  const { adoptSubagentProgressDraft } =
    await import("../src/agents/subagents/registry/subagent-progress-draft.js");
  const { subagentRuns } =
    await import("../src/agents/subagents/registry/subagent-registry-memory.js");
  type SubagentRunRecord =
    import("../src/agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord;
  type TelegramDispatchTurn =
    import("../extensions/telegram/src/bot-message-dispatch.types.js").TelegramDispatchTurn;

  const label = `${BOUNDARY_TITLE}\u{1F600}tail`;
  if (label.charCodeAt(119) < 0xd800 || label.charCodeAt(119) > 0xdbff) {
    throw new Error("boundary label does not place a high surrogate at UTF-16 index 119");
  }
  const telegramCfg = {
    streaming: { mode: "progress", progress: { maxLineChars: LINE_BUDGET, maxLines: 8 } },
  };
  const progressCompositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    showWorkStatus: true,
    entry: telegramCfg,
    mode: "progress",
    active: true,
    seed: "subagent-progress-title-proof",
    reasoningGate: false,
    toolIcons: true,
    updateOnLineChange: true,
    update: () => undefined,
  });
  const turn = {
    telegramCfg,
    richMessages: false,
    context: {
      chatId: 123,
      route: { accountId: "proof" },
      threadSpec: {},
    },
    progressCompositor,
    runtime: {},
  } as TelegramDispatchTurn;
  const stream = createTelegramDraftStream({
    api: new Bot(API_TOKEN, { client: { apiRoot } }).api,
    chatId: 123,
    throttleMs: 250,
    richMessages: false,
  });
  const card = retainProgressDraft(turn, stream);
  const startedAt = Date.now();
  const entry: SubagentRunRecord = {
    runId: "boundary-title",
    childSessionKey: "agent:main:subagent:boundary-title",
    childAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "boundary title",
    label,
    cleanup: "keep",
    createdAt: startedAt,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running", startedAt },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
  };
  subagentRuns.set(entry.runId, entry);
  try {
    const adopted = adoptSubagentProgressDraft(
      [
        {
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      card,
    );
    if (!adopted) {
      throw new Error("adoptSubagentProgressDraft did not retain the progress card");
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await stream.flush();
      if (stream.lastDeliveredText()?.includes(EXPECTED_ROW)) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    throw new Error(
      `Telegram did not deliver the boundary row: ${JSON.stringify(stream.lastDeliveredText() ?? "")}`,
    );
  } finally {
    subagentRuns.delete(entry.runId);
  }
}

if (process.env.PROGRESS_TITLE_PROOF_CHILD === "1") {
  await deliverRetainedCard();
} else {
  await recordDelivery();
}
