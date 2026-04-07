import { describe, it, expect } from "vitest";
import {
  isNoiseMemory,
  detectNoiseMemories,
  DEFAULT_NOISE_PATTERNS,
  type NoisePattern,
} from "../src/analysis/staleness-scorer.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

function makeRecord(id: string, text: string): MemoryRecord {
  return {
    id,
    text,
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: "{}",
    vector: [],
  };
}

describe("isNoiseMemory", () => {
  it("should detect Session metadata with Session Key", () => {
    const text =
      "Session: 2026-04-04 17:15:25 UTC\nSession Key: agent:emilia:discord:12345";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(true);
  });

  it("should not flag Session line without Session Key", () => {
    const text = "Session: 2026-04-04 17:15:25 UTC\nSome other content";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(false);
  });

  it("should detect Session ID with UUID", () => {
    const text = "Session ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(true);
  });

  it("should not flag Session ID with non-UUID format", () => {
    const text = "Session ID: not-a-uuid";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(false);
  });

  it("should detect short reflection-event noise", () => {
    const text = "reflection-event · agent: emilia status update";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(true);
  });

  it("should not flag long reflection-event text (> 200 chars)", () => {
    const text = "reflection-event · agent: " + "x".repeat(200);
    expect(text.length).toBeGreaterThan(200);
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(false);
  });

  it("should not flag normal memory text", () => {
    const text = "User prefers dark mode and uses TypeScript for all projects";
    expect(isNoiseMemory(text, DEFAULT_NOISE_PATTERNS)).toBe(false);
  });

  it("should return false for empty patterns array", () => {
    const text = "Session: 2026-04-04\nSession Key: abc";
    expect(isNoiseMemory(text, [])).toBe(false);
  });

  it("should support custom patterns", () => {
    const customPatterns: NoisePattern[] = [
      { regex: "^GARBAGE:", maxLength: 50 },
    ];
    expect(isNoiseMemory("GARBAGE: short", customPatterns)).toBe(true);
    expect(
      isNoiseMemory("GARBAGE: " + "x".repeat(50), customPatterns),
    ).toBe(false);
    expect(isNoiseMemory("Not garbage", customPatterns)).toBe(false);
  });
});

describe("detectNoiseMemories", () => {
  it("should filter noise memories from a list", () => {
    const memories = [
      makeRecord("noise-1", "Session: 2026-04-04 17:15:25 UTC\nSession Key: agent:test"),
      makeRecord("good-1", "User likes TypeScript"),
      makeRecord("noise-2", "Session ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      makeRecord("good-2", "Project uses Vitest for testing"),
    ];
    const noise = detectNoiseMemories(memories);
    expect(noise).toHaveLength(2);
    expect(noise.map((m) => m.id)).toEqual(["noise-1", "noise-2"]);
  });

  it("should return empty array when no noise found", () => {
    const memories = [
      makeRecord("ok-1", "Normal memory content"),
      makeRecord("ok-2", "Another normal memory"),
    ];
    expect(detectNoiseMemories(memories)).toHaveLength(0);
  });

  it("should use custom patterns when provided", () => {
    const memories = [
      makeRecord("m1", "CUSTOM_NOISE: blah"),
      makeRecord("m2", "Normal text"),
    ];
    const custom: NoisePattern[] = [{ regex: "^CUSTOM_NOISE:" }];
    const noise = detectNoiseMemories(memories, custom);
    expect(noise).toHaveLength(1);
    expect(noise[0].id).toBe("m1");
  });

  it("should use default patterns when none provided", () => {
    const memories = [
      makeRecord("s1", "Session ID: 00000000-0000-0000-0000-000000000000"),
    ];
    const noise = detectNoiseMemories(memories);
    expect(noise).toHaveLength(1);
  });
});
