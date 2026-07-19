import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamLegacyJsonTopLevelObjectEntries } from "./legacy-json-object-stream.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-legacy-json-stream-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

describe("streamLegacyJsonTopLevelObjectEntries", () => {
  it("streams top-level object entries without requiring a wrapper property", async () => {
    const filePath = tempFile("sessions.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        "agent:main:a": { sessionId: "a", updatedAt: 1 },
        "agent:main:b": { sessionId: "b", updatedAt: 2 },
      }),
      { mode: 0o600 },
    );
    const entries: Array<[string, unknown]> = [];
    const snapshot = await streamLegacyJsonTopLevelObjectEntries({
      filePath,
      maxEntryBytes: 1024,
      onEntry: (key, value) => {
        entries.push([key, value]);
      },
    });
    expect(snapshot.size).toBe(fs.statSync(filePath).size);
    expect(entries).toEqual([
      ["agent:main:a", { sessionId: "a", updatedAt: 1 }],
      ["agent:main:b", { sessionId: "b", updatedAt: 2 }],
    ]);
  });

  it("rejects a single entry above maxEntryBytes", async () => {
    const filePath = tempFile("huge-entry.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        huge: { sessionId: "huge", label: "x".repeat(200) },
      }),
      { mode: 0o600 },
    );
    await expect(
      streamLegacyJsonTopLevelObjectEntries({
        filePath,
        maxEntryBytes: 64,
        onEntry: () => undefined,
      }),
    ).rejects.toThrow(/File exceeds 64 bytes/);
  });

  it("rejects a file above maxFileBytes before parsing", async () => {
    const filePath = tempFile("big-file.json");
    fs.writeFileSync(filePath, `${"x".repeat(128)}`, { mode: 0o600 });
    await expect(
      streamLegacyJsonTopLevelObjectEntries({
        filePath,
        maxEntryBytes: 1024,
        maxFileBytes: 64,
        onEntry: () => undefined,
      }),
    ).rejects.toThrow(/File exceeds 64 bytes/);
  });
});
