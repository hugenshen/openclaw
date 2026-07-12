// Elevenlabs shared module tests.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  isValidElevenLabsVoiceId,
  normalizeElevenLabsBaseUrl,
} from "./shared.js";

describe("normalizeElevenLabsBaseUrl", () => {
  it("returns default when called with no argument", () => {
    expect(normalizeElevenLabsBaseUrl()).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns default for empty string", () => {
    expect(normalizeElevenLabsBaseUrl("")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("   ")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns default for malformed URL", () => {
    expect(normalizeElevenLabsBaseUrl("not-a-url")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("junk://example.com")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns default for non-http(s) URL", () => {
    expect(normalizeElevenLabsBaseUrl("file:///etc/passwd")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("ftp://example.com")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("javascript://x")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("strips trailing slashes from valid http(s) base URLs", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io/")).toBe(
      "https://api.elevenlabs.io",
    );
    expect(normalizeElevenLabsBaseUrl("https://proxy.example.com/v1///")).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("accepts http URLs for self-hosted deployments", () => {
    expect(normalizeElevenLabsBaseUrl("http://localhost:8000")).toBe("http://localhost:8000");
  });

  it("preserves valid https base URL unchanged", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io")).toBe(
      "https://api.elevenlabs.io",
    );
  });
});

describe("isValidElevenLabsVoiceId", () => {
  it("accepts alphanumeric ids in the expected length range", () => {
    expect(isValidElevenLabsVoiceId("AbCdEfGhIj")).toBe(true);
    expect(isValidElevenLabsVoiceId("A".repeat(40))).toBe(true);
  });

  it("rejects ids that are too short or too long", () => {
    expect(isValidElevenLabsVoiceId("short")).toBe(false);
    expect(isValidElevenLabsVoiceId("A".repeat(41))).toBe(false);
  });

  it("rejects ids with non-alphanumeric characters", () => {
    expect(isValidElevenLabsVoiceId("ABCDE-FGHIJ")).toBe(false);
    expect(isValidElevenLabsVoiceId("AbCdEfGhI ")).toBe(false);
  });
});
