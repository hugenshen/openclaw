// Tlon tests cover channel ops plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

const scryDeps = {
  baseUrl: "https://example.com",
  cookie: "urbauth-~zod=123",
} as const;

const scryParams = {
  path: "/chat/inbox.json",
  auditContext: "test",
} as const;

function oversizedScryJsonResponse(): Response {
  const prefix = '{"payload":"';
  const suffix = '"}';
  const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
  const targetBytes = 18 * 1024 * 1024;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        let sent = prefix.length;
        while (sent + bodyChunk.length + suffix.length < targetBytes) {
          controller.enqueue(bodyChunk);
          sent += bodyChunk.length;
        }
        controller.enqueue(new TextEncoder().encode(suffix));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("Urbit channel operations", () => {
  beforeEach(() => {
    vi.mocked(urbitFetch).mockReset();
  });

  it("parses successful scry JSON responses", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: Response.json({ inbox: [] }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).resolves.toEqual({ inbox: [] });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed scry response JSON", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).rejects.toThrow(
      "tlon.scry: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized scry JSON responses", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: oversizedScryJsonResponse(),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).rejects.toThrow(
      "tlon.scry: JSON response exceeds 16777216 bytes",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
