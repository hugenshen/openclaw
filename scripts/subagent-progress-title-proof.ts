// Shipped-entry proof for retained subagent progress titles.
// Run: node --import ./scripts/tsx.mjs scripts/subagent-progress-title-proof.ts
//
// projectChild truncates the child label, adoptSubagentProgressDraft pushes that
// item, and announce holds the same card through withSubagentProgressDraft.
// The card owner is Telegram's retained draft: createChannelProgressDraftCompositor
// plus renderTelegramProgressDraftPreview (extensions/telegram retainProgressDraft).
import { renderTelegramProgressDraftPreview } from "../extensions/telegram/src/progress-draft-preview.js";
import {
  adoptSubagentProgressDraft,
  withSubagentProgressDraft,
} from "../src/agents/subagents/registry/subagent-progress-draft.js";
import { subagentRuns } from "../src/agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import { createChannelProgressDraftCompositor } from "../src/channels/progress-draft-compositor.js";
import type { ItemProgressPayload } from "../src/channels/progress-draft-events.js";
import {
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
} from "../src/channels/streaming.js";

const RUN_ID = "boundary-title";
const CHILD_SESSION_KEY = "agent:main:subagent:boundary-title";
const WAKE_RUN_ID = "requester-settle-wake";
// 119 ASCII units put the emoji's high surrogate at index 119.
const BOUNDARY_LABEL = `${"a".repeat(119)}\u{1F600}tail`;

function hasUnpairedSurrogate(value: string): boolean {
  return !value.isWellFormed();
}

function visibleCardLines(markup: string): string[] {
  return markup
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function createRetainedTelegramCard() {
  let previewText = "";
  const compositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    showWorkStatus: true,
    entry: undefined,
    mode: "progress",
    active: true,
    seed: "subagent-progress-title-proof",
    reasoningGate: false,
    toolIcons: true,
    updateOnLineChange: true,
    update: (_text, options) => {
      previewText = renderTelegramProgressDraftPreview(options.snapshot, {
        toolProgress: compositor.previewToolProgressEnabled,
        richMessages: false,
        maxLines: resolveChannelProgressDraftMaxLines(undefined),
        maxLineChars: resolveChannelProgressDraftMaxLineChars(undefined),
      }).text;
    },
  });
  // retainProgressDraft starts the card, then applies the owner's pushes.
  let queue: Promise<unknown> = compositor.start();
  const draft = {
    push: (item: ItemProgressPayload) => {
      queue = queue.then(() => compositor.pushItemEvent(item));
    },
    retire: () => {
      queue = queue.then(async () => {
        compositor.cancel();
      });
    },
  };
  return {
    draft,
    flushed: () => queue,
    previewText: () => previewText,
  };
}

function yieldedBoundaryRun(): SubagentRunRecord {
  const startedAt = Date.now();
  return {
    runId: RUN_ID,
    childSessionKey: CHILD_SESSION_KEY,
    childAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "boundary title",
    label: BOUNDARY_LABEL,
    cleanup: "keep",
    createdAt: startedAt,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running", startedAt },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
  };
}

function renderedChildTitle(card: ReturnType<typeof createRetainedTelegramCard>): string {
  const prefix = "a".repeat(119);
  const fromPreview = visibleCardLines(card.previewText()).find((line) => line.includes(prefix));
  if (!fromPreview) {
    throw new Error(
      `retained card did not render the boundary title: ${JSON.stringify(card.previewText())}`,
    );
  }
  return fromPreview;
}

async function main(): Promise<void> {
  const high = BOUNDARY_LABEL.charCodeAt(119);
  if (high < 0xd800 || high > 0xdbff) {
    throw new Error("boundary label does not place a high surrogate at UTF-16 index 119");
  }
  const entry = yieldedBoundaryRun();
  subagentRuns.set(entry.runId, entry);
  const card = createRetainedTelegramCard();
  try {
    const adopted = adoptSubagentProgressDraft(
      [
        {
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      card.draft,
    );
    if (!adopted) {
      throw new Error("adoptSubagentProgressDraft did not retain the progress card");
    }
    await card.flushed();
    // Announce keeps this card for the requester settle wake.
    await withSubagentProgressDraft([entry], WAKE_RUN_ID, async () => {
      await card.flushed();
    });
    await card.flushed();
    const title = renderedChildTitle(card);
    const unpaired = hasUnpairedSurrogate(title);
    console.log(
      `[subagent-progress title proof] title_len=${title.length} unpaired=${unpaired} title=${title}`,
    );
    if (unpaired || !title.startsWith("a".repeat(119))) {
      throw new Error("rendered progress title still contains a broken boundary");
    }
  } finally {
    card.draft.retire();
    await card.flushed();
    subagentRuns.delete(entry.runId);
  }
}

await main();
