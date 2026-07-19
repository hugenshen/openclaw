// Streams one-property or top-level legacy JSON object stores without buffering
// the whole file. Entry values are still parsed as bounded objects.
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Root } from "@openclaw/fs-safe";
import { openLocalFileSafely } from "./fs-safe.js";

const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

type LegacyJsonStreamSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

class JsonCharacterCursor {
  private readonly chunks: AsyncIterator<string>;
  private chunk = "";
  private offset = 0;

  constructor(chunks: AsyncIterable<string>) {
    this.chunks = chunks[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    while (this.offset >= this.chunk.length) {
      const next = await this.chunks.next();
      if (next.done) {
        return false;
      }
      this.chunk = next.value;
      this.offset = 0;
    }
    return true;
  }

  async peek(): Promise<string | null> {
    return (await this.fill()) ? (this.chunk[this.offset] ?? null) : null;
  }

  async take(): Promise<string | null> {
    if (!(await this.fill())) {
      return null;
    }
    return this.chunk[this.offset++] ?? null;
  }

  async skipWhitespace(): Promise<void> {
    while (true) {
      const next = await this.peek();
      if (next === null || !JSON_WHITESPACE.has(next)) {
        return;
      }
      await this.take();
    }
  }
}

function parseLegacyJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // V8 parse errors can quote source bytes. Legacy state may contain device
    // credentials, so Doctor warnings must expose only a content-free message.
    throw new Error("legacy JSON store contains invalid JSON");
  }
}

async function expectCharacter(cursor: JsonCharacterCursor, expected: string): Promise<void> {
  await cursor.skipWhitespace();
  const actual = await cursor.take();
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)} in legacy JSON store`);
  }
}

async function readJsonString(cursor: JsonCharacterCursor): Promise<string> {
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== '"') {
    throw new Error("expected string in legacy JSON store");
  }
  let raw = '"';
  let escaped = false;
  while (true) {
    const character = await cursor.take();
    if (character === null) {
      throw new Error("unterminated string in legacy JSON store");
    }
    raw += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const parsed = parseLegacyJson(raw);
      if (typeof parsed !== "string") {
        throw new Error("invalid string in legacy JSON store");
      }
      return parsed;
    }
  }
}

async function readJsonObject(
  cursor: JsonCharacterCursor,
  maxEntryBytes?: number,
): Promise<unknown> {
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== "{") {
    throw new Error("legacy JSON entries must be objects");
  }
  let raw = "{";
  let depth = 1;
  let escaped = false;
  let inString = false;
  while (depth > 0) {
    const character = await cursor.take();
    if (character === null) {
      throw new Error("unterminated object in legacy JSON store");
    }
    raw += character;
    // Session JSON is ASCII-heavy; string length is a tight enough byte proxy
    // for the per-entry support ceiling without encoding every character.
    if (maxEntryBytes !== undefined && raw.length > maxEntryBytes) {
      throw new Error(`File exceeds ${maxEntryBytes} bytes`);
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }
  }
  return parseLegacyJson(raw);
}

async function parseObjectEntries(params: {
  cursor: JsonCharacterCursor;
  maxEntryBytes?: number;
  onEntry: (key: string, value: unknown) => void;
}): Promise<void> {
  await params.cursor.skipWhitespace();
  if ((await params.cursor.peek()) === "}") {
    await params.cursor.take();
    return;
  }
  while (true) {
    const key = await readJsonString(params.cursor);
    await expectCharacter(params.cursor, ":");
    params.onEntry(key, await readJsonObject(params.cursor, params.maxEntryBytes));
    await params.cursor.skipWhitespace();
    const separator = await params.cursor.take();
    if (separator === "}") {
      return;
    }
    if (separator !== ",") {
      throw new Error("expected comma or object end in legacy JSON store");
    }
  }
}

async function parseSinglePropertyObject(params: {
  chunks: AsyncIterable<string>;
  property: string;
  onEntry: (key: string, value: unknown) => void;
}): Promise<void> {
  const cursor = new JsonCharacterCursor(params.chunks);
  await expectCharacter(cursor, "{");
  const property = await readJsonString(cursor);
  if (property !== params.property) {
    throw new Error(`legacy JSON store must contain only ${params.property}`);
  }
  await expectCharacter(cursor, ":");
  await expectCharacter(cursor, "{");
  await parseObjectEntries({ cursor, onEntry: params.onEntry });
  await expectCharacter(cursor, "}");
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== null) {
    throw new Error("legacy JSON store has trailing content");
  }
}

async function parseTopLevelObjectEntries(params: {
  chunks: AsyncIterable<string>;
  maxEntryBytes: number;
  onEntry: (key: string, value: unknown) => void;
}): Promise<void> {
  const cursor = new JsonCharacterCursor(params.chunks);
  await expectCharacter(cursor, "{");
  await parseObjectEntries({
    cursor,
    maxEntryBytes: params.maxEntryBytes,
    onEntry: params.onEntry,
  });
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== null) {
    throw new Error("legacy JSON store has trailing content");
  }
}

async function* decodeUtf8Chunks(params: {
  handle: FileHandle;
  hash?: ReturnType<typeof createHash>;
  onBytes: (length: number) => void;
  maxBytes?: number;
}): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = params.handle.createReadStream({ autoClose: false, start: 0 });
  let size = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (params.maxBytes !== undefined && size > params.maxBytes) {
      throw new Error(`File exceeds ${params.maxBytes} bytes`);
    }
    params.hash?.update(chunk);
    params.onBytes(chunk.byteLength);
    const text = decoder.decode(chunk, { stream: true });
    if (text) {
      yield text;
    }
  }
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

function assertStableRead(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
  bytesRead: number,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size ||
    bytesRead !== after.size
  ) {
    throw new Error("legacy JSON store changed while it was being read");
  }
}

/** Hash a safely opened file, optionally parsing its single object property entry by entry. */
export async function readLegacyJsonObjectStream(params: {
  stateRoot: Root;
  relativePath: string;
  property?: string;
  onEntry?: (key: string, value: unknown) => void;
}): Promise<LegacyJsonStreamSnapshot> {
  const opened = await params.stateRoot.open(params.relativePath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  const hash = createHash("sha256");
  let size = 0;
  try {
    const before = opened.stat;
    if (params.property && params.onEntry) {
      const chunks = decodeUtf8Chunks({
        handle: opened.handle,
        hash,
        onBytes: (length) => {
          size += length;
        },
      });
      await parseSinglePropertyObject({
        chunks,
        property: params.property,
        onEntry: params.onEntry,
      });
    } else {
      const stream = opened.handle.createReadStream({ autoClose: false, start: 0 });
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        hash.update(chunk);
        size += chunk.byteLength;
      }
    }
    const after = await opened.handle.stat();
    assertStableRead(before, after, size);
    return {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      sha256: hash.digest("hex"),
      size,
    };
  } catch (error) {
    if (error instanceof TypeError && /encoded data was not valid/i.test(error.message)) {
      throw new Error("legacy JSON store is not valid UTF-8", { cause: error });
    }
    throw error;
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}

/**
 * Stream a top-level `{ key: object, ... }` legacy store entry-by-entry.
 * Used when the whole-file JSON.parse path would exceed the inline byte ceiling.
 */
export async function streamLegacyJsonTopLevelObjectEntries(params: {
  filePath: string;
  maxEntryBytes: number;
  maxFileBytes?: number;
  onEntry: (key: string, value: unknown) => void;
}): Promise<{ size: number }> {
  const opened = await openLocalFileSafely({ filePath: params.filePath });
  let size = 0;
  try {
    if (params.maxFileBytes !== undefined && opened.stat.size > params.maxFileBytes) {
      throw new Error(`File exceeds ${params.maxFileBytes} bytes`);
    }
    const before = opened.stat;
    const chunks = decodeUtf8Chunks({
      handle: opened.handle,
      maxBytes: params.maxFileBytes,
      onBytes: (length) => {
        size += length;
      },
    });
    await parseTopLevelObjectEntries({
      chunks,
      maxEntryBytes: params.maxEntryBytes,
      onEntry: params.onEntry,
    });
    const after = await opened.handle.stat();
    assertStableRead(before, after, size);
    return { size };
  } catch (error) {
    if (error instanceof TypeError && /encoded data was not valid/i.test(error.message)) {
      throw new Error("legacy JSON store is not valid UTF-8", { cause: error });
    }
    throw error;
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}
