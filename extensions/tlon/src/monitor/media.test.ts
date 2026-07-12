// Tlon tests cover media plugin behavior.
import {
  readRemoteMediaBuffer,
  MAX_IMAGE_BYTES,
  saveRemoteMedia,
} from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadMedia,
  extractImageBlocks,
  TLON_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
} from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
  saveRemoteMedia: vi.fn(),
}));

const readRemoteMediaBufferMock = vi.mocked(readRemoteMediaBuffer);
const saveRemoteMediaMock = vi.mocked(saveRemoteMedia);

describe("tlon monitor media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps extracted images at eight per message", () => {
    const content = Array.from({ length: 10 }, (_, index) => ({
      block: { image: { src: `https://example.com/${index}.png`, alt: `image-${index}` } },
    }));

    const images = extractImageBlocks(content);

    expect(images).toHaveLength(8);
    expect(images.map((image) => image.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("stores fetched media through the shared inbound media store with the image cap", async () => {
    saveRemoteMediaMock.mockResolvedValue({
      id: "photo---uuid.png",
      path: "/tmp/openclaw/media/inbound/photo---uuid.png",
      size: "image-data".length,
      contentType: "image/png",
    });

    const result = await downloadMedia("https://example.com/photo.png");

    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: "https://example.com/photo.png",
      maxBytes: MAX_IMAGE_BYTES,
      responseHeaderTimeoutMs: TLON_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
      readIdleTimeoutMs: 30_000,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    expect(result).toEqual({
      localPath: "/tmp/openclaw/media/inbound/photo---uuid.png",
      contentType: "image/png",
      originalUrl: "https://example.com/photo.png",
    });
  });

  it("returns null when the fetch exceeds the image cap", async () => {
    saveRemoteMediaMock.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/photo.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await downloadMedia("https://example.com/photo.png");

    expect(result).toBeNull();
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
  });

  it("times out inbound media downloads when response headers never arrive", async () => {
    const { createServer } = await import("node:http");
    const { saveRemoteMedia: realSaveRemoteMedia } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/media-runtime")
    >("openclaw/plugin-sdk/media-runtime");

    const server = createServer((_req, _res) => {
      // Accept the connection but never write status/headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const stallUrl = `http://127.0.0.1:${address.port}/stall.png`;
    const headerTimeoutMs = 250;

    // Production downloadMedia passes the full timeout budget; the harness shortens
    // only the actual fetch so the stalled-header case stays fast.
    const saveRemoteMediaWithHeaderTimeout: typeof realSaveRemoteMedia = async (params) => {
      expect(params).toEqual({
        url: stallUrl,
        maxBytes: MAX_IMAGE_BYTES,
        responseHeaderTimeoutMs: TLON_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
        readIdleTimeoutMs: 30_000,
        ssrfPolicy: undefined,
        requestInit: { method: "GET" },
      });
      return await realSaveRemoteMedia({
        ...params,
        responseHeaderTimeoutMs: headerTimeoutMs,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });
    };
    saveRemoteMediaMock.mockImplementation(saveRemoteMediaWithHeaderTimeout);

    const started = Date.now();
    const result = await downloadMedia(stallUrl);
    const elapsedMs = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
    expect(elapsedMs).toBeLessThan(headerTimeoutMs + 2_000);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
