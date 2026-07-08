// Signal tests cover daemon plugin behavior.
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testApi } from "./daemon.js";

describe("signal daemon args", () => {
  it("expands home-relative configPath before passing it to signal-cli", () => {
    expect(
      testApi.buildDaemonArgs({
        cliPath: "signal-cli",
        configPath: "~/.openclaw/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toEqual([
      "--config",
      path.join(os.homedir(), ".openclaw/signal-cli"),
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--no-receive-stdout",
    ]);
  });
});

describe("signal daemon stdio stream error handling", () => {
  it("routes stdout 'error' events to the error callback instead of throwing", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream;
    const log = vi.fn();
    const error = vi.fn();
    testApi.bindSignalCliOutput({ stream, log, error });

    // Before the fix this would propagate as an unhandled EventEmitter error
    // and crash the gateway process.
    expect(() => {
      stream.emit("error", new Error("write EPIPE"));
    }).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli stdio error: Error: write EPIPE"),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("routes stderr 'error' events to the error callback instead of throwing", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream;
    const error = vi.fn();
    testApi.bindSignalCliOutput({ stream, log: vi.fn(), error });

    expect(() => {
      stream.emit("error", new Error("read EIO"));
    }).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli stdio error: Error: read EIO"),
    );
  });

  it("does not interfere with normal data events after an error", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream;
    const log = vi.fn();
    const error = vi.fn();
    testApi.bindSignalCliOutput({ stream, log, error });

    stream.emit("error", new Error("transient"));
    stream.emit("data", Buffer.from("INFO  DaemonCommand - started\n"));

    expect(log).toHaveBeenCalledWith("signal-cli: INFO  DaemonCommand - started");
  });

  it("is a no-op for a null stream", () => {
    expect(() => {
      testApi.bindSignalCliOutput({ stream: null, log: vi.fn(), error: vi.fn() });
    }).not.toThrow();
  });
});

describe("signal daemon log classification", () => {
  it("keeps routine signal-cli warnings out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "WARN  ManagerImpl - No profile name set. When sending a message it's recommended to set a profile name.",
      ),
    ).toBe("log");
  });

  it("keeps recoverable prekey decrypt receive failures out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      ),
    ).toBe("log");
  });

  it("still surfaces signal-cli failures as errors", () => {
    expect(testApi.classifySignalCliLogLine("ERROR DaemonCommand - startup failed")).toBe("error");
    expect(testApi.classifySignalCliLogLine("SEVERE Manager - database exception")).toBe("error");
  });
});
