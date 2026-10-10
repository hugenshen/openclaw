// Production uploadFile against a real loopback S3: PUT stores bytes, GET retrieves
// by the encoded public URL key. Urbit auth/scry are mocked to point at the loopback;
// AWS signing and guarded PUT transport stay on the production path.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(),
}));

vi.mock("./urbit/channel-ops.js", () => ({
  scryUrbitPath: vi.fn(),
}));

import { uploadFile } from "./tlon-api.js";

const mockAuthenticate = vi.mocked(authenticate);
const mockScryUrbitPath = vi.mocked(scryUrbitPath);

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const BUCKET = "uploads";

async function withLoopbackS3(
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const objects = new Map<string, Buffer>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    void (async () => {
      try {
        if (request.method === "PUT") {
          // Path-style S3: /{bucket}/{key...}
          const prefix = `/${BUCKET}/`;
          if (!pathname.startsWith(prefix)) {
            response.writeHead(404);
            response.end("missing bucket prefix");
            return;
          }
          const key = pathname.slice(prefix.length);
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200);
          response.end();
          return;
        }
        if (request.method === "GET") {
          // Public URL: /{encoded key segments} (no bucket)
          const key = pathname.replace(/^\//, "");
          const body = objects.get(key);
          if (!body) {
            response.writeHead(404);
            response.end("not found");
            return;
          }
          response.writeHead(200, { "content-type": "image/png" });
          response.end(body);
          return;
        }
        response.writeHead(405);
        response.end();
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    })();
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

describe("uploadFile custom S3 loopback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["photo#1.png", "photo?v=1.png"] as const)(
    "uploads %s and retrieves the same bytes from the encoded public URL",
    async (fileName) => {
      await withLoopbackS3(async (origin) => {
        mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
        mockScryUrbitPath.mockImplementation(async (_deps, { path }) => {
          if (path === "/storage/configuration.json") {
            return {
              currentBucket: BUCKET,
              buckets: [BUCKET],
              publicUrlBase: `${origin}/`,
              presignedUrl: "",
              region: "us-east-1",
              service: "custom",
            };
          }
          if (path === "/storage/credentials.json") {
            return {
              "storage-update": {
                credentials: {
                  endpoint: origin,
                  accessKeyId: "AKIAFAKELOOPBACK",
                  secretAccessKey: "fake-secret-loopback",
                },
              },
            };
          }
          throw new Error(`Unexpected scry path: ${path}`);
        });

        const result = await uploadFile(
          {
            blob: new Blob([PNG_BYTES], { type: "image/png" }),
            fileName,
            contentType: "image/png",
          },
          {
            shipUrl: "https://ship.example.com",
            shipName: "~zod",
            getCode: async () => "fixture-code",
            dangerouslyAllowPrivateNetwork: true,
          },
        );

        const publicUrl = new URL(result.url);
        expect(publicUrl.origin).toBe(origin);
        expect(publicUrl.hash).toBe("");
        expect(publicUrl.search).toBe("");
        expect(publicUrl.pathname).toContain(encodeURIComponent(fileName));
        expect(decodeURIComponent(publicUrl.pathname)).toContain(fileName);

        const retrieved = await fetch(result.url);
        expect(retrieved.status).toBe(200);
        const retrievedBytes = Buffer.from(await retrieved.arrayBuffer());
        expect(retrievedBytes.equals(PNG_BYTES)).toBe(true);
        console.log(
          `[tlon custom-s3 loopback proof] fileName=${fileName} publicUrl=${result.url} bytes=${retrievedBytes.length}`,
        );
      });
    },
  );
});
