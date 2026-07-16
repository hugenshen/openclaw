// Qa Lab tests prove Crabline inbound fetch is timed and JSON-bounded.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const readProviderJsonResponseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  readProviderJsonResponse: readProviderJsonResponseMock,
}));

import { qaLabCrablineInboundTesting } from "./crabline-transport.js";

describe("qaLabCrablineInboundTesting.postCrablineInbound", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    readProviderJsonResponseMock.mockReset();
  });

  it("passes timeoutMs and reads JSON through the bounded provider helper", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      release,
    });
    readProviderJsonResponseMock.mockResolvedValue({
      update: { message: { message_id: 42 } },
    });

    const messageId = await qaLabCrablineInboundTesting.postCrablineInbound({
      adapter: {
        channel: "telegram",
        manifest: {
          adminToken: "admin-token",
          endpoints: { adminInboundUrl: "http://127.0.0.1:43123/admin/inbound" },
        },
      } as never,
      providerInbound: { providerBody: { text: "ping" } } as never,
    });

    expect(messageId).toBe("42");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: qaLabCrablineInboundTesting.timeoutMs,
        auditContext: "qa-lab-crabline-telegram-inbound",
        url: "http://127.0.0.1:43123/admin/inbound",
      }),
    );
    expect(qaLabCrablineInboundTesting.timeoutMs).toBe(15_000);
    expect(readProviderJsonResponseMock).toHaveBeenCalledWith(
      expect.any(Response),
      "qa-lab-crabline-telegram-inbound",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
