import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { buildCronExecOperationBinding } from "../operator-approval-standing-grants.js";
import type { CronStandingGrantListing } from "../operator-approval-standing-grants.types.js";
import { createClient, createApprovalInvocation } from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

const listCronStandingGrantsMock = vi.hoisted(() => vi.fn());

vi.mock("../operator-approval-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operator-approval-store.js")>();
  return {
    ...actual,
    listCronStandingGrants: listCronStandingGrantsMock,
  };
});

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

describe("exec.approval.grants.list UTF-16 display bounds", () => {
  it("does not split a surrogate pair at the 512-char grant command and cwd caps", async () => {
    const lobster = "🦞";
    const command = `${"a".repeat(511)}${lobster}`;
    const cwd = `${"b".repeat(511)}${lobster}`;
    const grant: CronStandingGrantListing = {
      grantId: "grant-utf16",
      mintedByApprovalId: "approval-utf16",
      agentId: "main",
      cronJobId: "job-utf16",
      jobConfigRevision: "rev-1",
      operationBinding: buildCronExecOperationBinding({ command, cwd, env: undefined }),
      createdAtMs: 1,
      expiresAtMs: null,
      lastUsedAtMs: null,
      useCount: 0,
      cronJobName: "Nightly",
      revokedAtMs: null,
      revokedBy: null,
    };
    listCronStandingGrantsMock.mockResolvedValueOnce([grant]);

    const { invoke } = createApprovalInvocation({
      handlers: createExecApprovalHandlers({} as ExecApprovalManager),
      method: "exec.approval.grants.list",
      body: {},
      client: createClient({ scopes: ["operator.approvals"] }),
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
    console.log(
      `[exec.approval.grants.list utf16 proof] command_len=${listedCommand.length} cwd_len=${listedCwd.length} unpaired=false`,
    );
  });
});
