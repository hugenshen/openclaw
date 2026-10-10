// Production uploadImageFromUrl against a real Content-Disposition HTTP response.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "../tlon-api.js";
import { uploadImageFromUrl } from "./upload.js";

const actualReadRemoteMediaBuffer = vi.hoisted(() => ({
  current: null as typeof readRemoteMediaBuffer | null,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  actualReadRemoteMediaBuffer.current = actual.readRemoteMediaBuffer;
  return {
    ...actual,
    readRemoteMediaBuffer: vi.fn((opts: Parameters<typeof actual.readRemoteMediaBuffer>[0]) => {
      const origin = new URL(opts.url).origin;
      return actual.readRemoteMediaBuffer({
        ...opts,
        // Loopback reflectors are private; production CDN fetches use the same downloader.
        ssrfPolicy: { allowedOrigins: [origin] },
      });
    }),
  };
});

// mock-isolation: Observe the selected upload filename without exercising live Tlon storage.
vi.mock("../tlon-api.js", () => ({
  uploadFile: vi.fn(),
}));

const mockUploadFile = vi.mocked(uploadFile);
const clientConfig = {
  shipUrl: "https://zod.tlon.network",
  shipName: "zod",
  getCode: async () => "fixture-code",
};

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function withImageServer(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(respond);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an ephemeral loopback address");
  }
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  try {
    await run(origin);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("uploadImageFromUrl Content-Disposition HTTP", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["photo.png", "photo#1.png", "photo?v=1.png"] as const)(
    "stores Content-Disposition filename %s from a real HTTP download",
    async (fileName) => {
      mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });
      await withImageServer(
        (_request, response) => {
          response.writeHead(200, {
            "content-type": "image/png",
            "content-disposition": `attachment; filename="${fileName}"`,
          });
          response.end(PNG_1X1);
        },
        async (origin) => {
          const imageUrl = `${origin}/download?id=123`;
          const result = await uploadImageFromUrl(imageUrl, clientConfig);
          const [call] = mockUploadFile.mock.calls;
          if (!call) {
            throw new Error("expected Tlon uploadFile call");
          }
          const [uploadParams] = call;
          expect(result).toBe("https://memex.tlon.network/uploaded.png");
          expect(uploadParams?.fileName).toBe(fileName);
          expect(actualReadRemoteMediaBuffer.current).not.toBeNull();
          console.log(
            `[tlon content-disposition proof] stored_filename=${uploadParams?.fileName} source=${imageUrl}`,
          );
        },
      );
    },
  );
});
