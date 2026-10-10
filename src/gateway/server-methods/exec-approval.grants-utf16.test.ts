import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../../cron/store/row-codec.js";
import type { CronStoredJob } from "../../cron/types.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  buildCronExecOperationBinding,
} from "../operator-approval-standing-grants.js";
import {
  insertOperatorApproval,
  listCronStandingGrants,
  resolveOperatorApproval,
} from "../operator-approval-store.js";
import * as approvalStore from "../operator-approval-store.js";
import { createClient, createApprovalInvocation, createContext } from "./approval.test-support.js";
import {
  createExecApprovalFixture,
  getRequestedExecApprovalPayload,
  requestExecApproval,
} from "./exec-approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

const CRON_STORE_KEY = "/tmp/openclaw-utf16-grant-test-store";
const NOW_MS = 1_756_000_000_000;
const tempDirs: string[] = [];

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
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

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-utf16-grant-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function seedCronJob(
  databaseOptions: OpenClawStateDatabaseOptions,
  jobName = "Standing grant job",
): string {
  const job = {
    id: "job-utf16",
    agentId: "main",
    name: jobName,
    enabled: true,
    createdAtMs: NOW_MS - 1_000,
    updatedAtMs: NOW_MS - 1_000,
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run the backup" },
    state: {},
  } as CronStoredJob;
  const database = openOpenClawStateDatabase(databaseOptions);
  upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
  const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
  const loadedJob = loaded.store.jobs.find((entry) => entry.id === job.id);
  if (!loadedJob) {
    throw new Error(`seeded cron job ${job.id} did not load back`);
  }
  return resolveCronJobConfigRevision(loadedJob);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("exec approval UTF-16 display bounds", () => {
  it("keeps standing-grant card automation/command previews surrogate-safe at 128/256", async (test) => {
    const lobster = "🦞";
    const jobName = `${"n".repeat(127)}${lobster}`;
    const command = `${"a".repeat(255)}${lobster}`;
    const runId = "run-utf16-card";
    test.onTestFinished(
      registerCronRunExecSource(runId, {
        agentId: "main",
        jobId: "job-utf16",
        jobConfigRevision: "rev-utf16",
        jobName,
      }),
    );

    const fixture = await createExecApprovalFixture(test, { preparePersistence: false });
    await fixture.run(async () => {
      const { handlers, respond, context, broadcasts } = fixture;
      await requestExecApproval({
        handlers,
        respond,
        context,
        params: {
          id: "approval-utf16-card",
          command,
          host: "gateway",
          agentId: "main",
          runId,
          twoPhase: true,
          requireDeliveryRoute: false,
          timeoutMs: 60_000,
          systemRunPlan: undefined,
          commandArgv: undefined,
          nodeId: undefined,
        },
        client: createClient({ scopes: ["operator.approvals"], internal: true }),
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const requested = getRequestedExecApprovalPayload(broadcasts);
      const scope = requested.request.scope as {
        kind?: string;
        automation?: string;
        command?: string;
      };
      expect(scope.kind).toBe("standing-grant");
      const automation = scope.automation ?? "";
      const scopedCommand = scope.command ?? "";
      expect(hasUnpairedSurrogate(automation)).toBe(false);
      expect(hasUnpairedSurrogate(scopedCommand)).toBe(false);
      expect(automation).toBe("n".repeat(127));
      expect(scopedCommand).toBe("a".repeat(255));
      expect(automation).not.toContain(lobster);
      expect(scopedCommand).not.toContain(lobster);
      console.log(
        `[exec.approval.request standing-grant card utf16 proof] automation_len=${automation.length} command_len=${scopedCommand.length} unpaired=false boundaries=128,256`,
      );
    });
  });

  it("lists minted standing grants with surrogate-safe 512-char command/cwd caps", async () => {
    const lobster = "🦞";
    const command = `${"a".repeat(511)}${lobster}`;
    const cwd = `${"b".repeat(511)}${lobster}`;
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    const operationBinding = buildCronExecOperationBinding({ command, cwd, env: undefined });

    await insertOperatorApproval({
      approval: {
        id: "approval-utf16-list",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "echo standing",
          commandPreview: "echo standing",
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
        reviewerDeviceIds: [],
        source: {
          agentId: "main",
          sessionKey: "agent:main:cron:job-utf16",
          sessionId: "session-utf16",
          runId: "run-utf16-list",
          toolCallId: null,
          toolName: "exec",
        },
        audienceSessionKeys: [],
        runtimeEpoch: "epoch-utf16",
        createdAtMs: NOW_MS,
        expiresAtMs: NOW_MS + 60_000,
      },
      databaseOptions,
    });
    const resolved = await resolveOperatorApproval({
      id: "approval-utf16-list",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer-1" },
      nowMs: NOW_MS + 1_000,
      databaseOptions,
      standingGrant: {
        kind: "cron",
        agentId: "main",
        cronJobId: "job-utf16",
        jobConfigRevision: revision,
        operationBinding,
        expiresAtMs: null,
      },
    });
    expect(resolved.outcome).toBe("resolved");

    const minted = await listCronStandingGrants({ databaseOptions });
    expect(minted).toHaveLength(1);

    // Production handler reads the live store; inject only the fixture database
    // options so this Vitest process uses the minted rows without mocking records.
    const list = approvalStore.listCronStandingGrants;
    vi.spyOn(approvalStore, "listCronStandingGrants").mockImplementation(async (params) =>
      list({ ...params, databaseOptions }),
    );

    const { invoke } = createApprovalInvocation({
      handlers: createExecApprovalHandlers({} as ExecApprovalManager),
      method: "exec.approval.grants.list",
      body: {},
      client: createClient({ scopes: ["operator.approvals"] }),
      context: createContext(),
    });
    const response = await invoke();
    expect(response.ok).toBe(true);
    const listed = response.result as { grants: Array<{ command: string; cwd: string | null }> };
    const listedCommand = listed.grants[0]?.command ?? "";
    const listedCwd = listed.grants[0]?.cwd ?? "";
    expect(hasUnpairedSurrogate(listedCommand)).toBe(false);
    expect(hasUnpairedSurrogate(listedCwd)).toBe(false);
    expect(listedCommand).toBe("a".repeat(511));
    expect(listedCwd).toBe("b".repeat(511));
    expect(listedCommand).not.toContain(lobster);
    expect(listedCwd).not.toContain(lobster);
    console.log(
      `[exec.approval.grants.list utf16 proof] store=real-sqlite command_len=${listedCommand.length} cwd_len=${listedCwd.length} unpaired=false boundary=512`,
    );
  });
});
