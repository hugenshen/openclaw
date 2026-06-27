import { once } from "node:events";
// Loopback proof: Zalo getMe through callZaloApi bounded JSON read path.
import { createServer } from "node:http";
import { resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");

const { getMe } = await import(`${pkgRoot}/extensions/zalo/src/api.ts`);

const CAP = 16 * 1024 * 1024;
const STREAM_SIZE = 24 * 1024 * 1024;

let allPassed = true;
function check(label, val) {
  console.log(`  ${val ? "ok" : "FAIL"}: ${label}`);
  if (!val) {
    allPassed = false;
  }
}

let serverBytesWritten = 0;

function writeHugeJsonStream(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(65536, 120);
  const header = Buffer.from('{"ok":true,"result":{"id":"bot-1"');
  res.write(header);
  serverBytesWritten += header.length;
  let sent = header.length;
  const writeNext = () => {
    if (sent >= STREAM_SIZE) {
      const tail = Buffer.from("}}");
      res.write(tail);
      serverBytesWritten += tail.length;
      res.end();
      return;
    }
    const ok = res.write(chunk);
    serverBytesWritten += chunk.length;
    sent += chunk.length;
    if (ok) {
      setImmediate(writeNext);
    } else {
      res.once("drain", writeNext);
    }
  };
  writeNext();
}

function createHugeServer() {
  return createServer((req, res) => {
    if (req.url === "/huge" || req.url?.endsWith("/getMe")) {
      writeHugeJsonStream(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function createSmallServer() {
  return createServer((req, res) => {
    if (req.url?.endsWith("/getMe")) {
      const body = JSON.stringify({ ok: true, result: { id: "bot-1", display_name: "proof" } });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      serverBytesWritten += Buffer.byteLength(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function withServer(server, fn) {
  serverBytesWritten = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const fetcher = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/getMe")) {
      return fetch(`http://127.0.0.1:${port}/botproof-token/getMe`, {
        ...init,
        method: "POST",
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
    }
    return fetch(input, init);
  };
  try {
    await fn(port, fetcher);
  } finally {
    await new Promise((resolveDone) => {
      server.close(resolveDone);
    });
  }
}

console.log(`\n[proof] Zalo getMe via callZaloApi production path`);
console.log(`  cap=${CAP} bytes (16 MiB), would-stream≈${STREAM_SIZE} bytes (24 MiB)\n`);

await withServer(createHugeServer(), async (_port, fetcher) => {
  serverBytesWritten = 0;
  let err;
  try {
    await getMe("proof-token", undefined, fetcher);
  } catch (error) {
    err = error;
  }
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  check("oversized getMe throws through production getMe/callZaloApi", err != null);
  check(
    `bounded error present: "${String(err?.message ?? err).slice(0, 72)}"`,
    String(err?.message ?? err).includes("zalo.getMe: JSON response exceeds 16777216 bytes"),
  );
  check(
    `server wrote ${serverBytesWritten} bytes, stopped before full 24 MiB stream`,
    serverBytesWritten < STREAM_SIZE && serverBytesWritten > CAP,
  );
});

await withServer(createHugeServer(), async (port) => {
  serverBytesWritten = 0;
  const res = await fetch(`http://127.0.0.1:${port}/huge`, { method: "POST" });
  await res.json().catch(() => undefined);
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  check(
    `negative control: unbounded .json() wrote ${serverBytesWritten} bytes (>> ${CAP})`,
    serverBytesWritten > CAP,
  );
});

await withServer(createSmallServer(), async (_port, fetcher) => {
  serverBytesWritten = 0;
  const result = await getMe("proof-token", undefined, fetcher);
  check(
    `small getMe parsed through production path (id=${result.result?.id})`,
    result.ok === true && result.result?.id === "bot-1",
  );
});

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
