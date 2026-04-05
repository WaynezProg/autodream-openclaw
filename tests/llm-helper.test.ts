import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmHelper, type SubagentRuntime } from "../src/analysis/llm-helper.js";
import { confirmConflictsWithLlm, type AmbiguousPair } from "../src/analysis/conflict-detector.js";
import { resolveTimeWithLlm, type TimeFixEntry } from "../src/analysis/time-normalizer.js";
import { mergeWithLlm } from "../src/analysis/dedup-merger.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";
import type { DedupPair } from "../src/analysis/dedup-detector.js";

function makeMockRuntime(responses: string[]): SubagentRuntime {
  let callIdx = 0;
  return {
    run: vi.fn().mockImplementation(async () => ({
      runId: `run-${callIdx++}`,
    })),
    waitForRun: vi.fn().mockImplementation(async () => {
      const idx = callIdx - 1;
      if (idx < responses.length) {
        return {
          status: "ok" as const,
          payloads: [{ text: responses[idx] }],
        };
      }
      return { status: "error" as const };
    }),
  };
}

function makeRecord(id: string, text: string, extra?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id,
    text,
    category: "decision",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: "{}",
    vector: [1, 0],
    ...extra,
  };
}

// ============================================================
// LlmHelper core (subagent backend)
// ============================================================

describe("LlmHelper", () => {
  it("should return response text on success", async () => {
    const runtime = makeMockRuntime(["YES. They contradict each other."]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const result = await llm.ask("test prompt");
    expect(result).toBe("YES. They contradict each other.");
    expect(llm.used).toBe(1);
    expect(llm.remaining).toBe(9);
  });

  it("should return null when no runtime and no provider", async () => {
    const llm = new LlmHelper(null);
    const result = await llm.ask("test");
    expect(result).toBeNull();
    expect(llm.logs[0].error).toBe("no runtime");
  });

  it("should enforce rate limiting", async () => {
    const runtime = makeMockRuntime(["a", "b", "c"]);
    const llm = new LlmHelper(runtime, { maxCalls: 2, timeoutMs: 5000 });

    await llm.ask("first");
    await llm.ask("second");
    const third = await llm.ask("third");

    expect(third).toBeNull();
    expect(llm.exhausted).toBe(true);
    expect(llm.used).toBe(2);
    expect(llm.logs).toHaveLength(3);
    expect(llm.logs[2].error).toBe("budget exhausted");
  });

  it("should return null on timeout", async () => {
    const runtime: SubagentRuntime = {
      run: vi.fn().mockResolvedValue({ runId: "run-1" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "timeout" }),
    };
    const llm = new LlmHelper(runtime, { maxCalls: 5, timeoutMs: 100 });

    const result = await llm.ask("test");
    expect(result).toBeNull();
    expect(llm.logs[0].error).toBe("status: timeout");
  });

  it("should return null on error status", async () => {
    const runtime: SubagentRuntime = {
      run: vi.fn().mockResolvedValue({ runId: "run-1" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "error" }),
    };
    const llm = new LlmHelper(runtime, { maxCalls: 5, timeoutMs: 5000 });

    const result = await llm.ask("test");
    expect(result).toBeNull();
  });

  it("should return null on runtime exception", async () => {
    const runtime: SubagentRuntime = {
      run: vi.fn().mockRejectedValue(new Error("network failure")),
      waitForRun: vi.fn(),
    };
    const llm = new LlmHelper(runtime, { maxCalls: 5, timeoutMs: 5000 });

    const result = await llm.ask("test");
    expect(result).toBeNull();
    expect(llm.logs[0].error).toBe("network failure");
    // Still counts against budget
    expect(llm.used).toBe(1);
  });

  it("should parse provider:model format", async () => {
    const runtime = makeMockRuntime(["ok"]);
    const llm = new LlmHelper(runtime, {
      model: "openai:gpt-4o-mini",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );
  });

  it("should log all calls for debugging", async () => {
    const runtime = makeMockRuntime(["response1", "response2"]);
    const llm = new LlmHelper(runtime, { maxCalls: 5, timeoutMs: 5000 });

    await llm.ask("prompt1");
    await llm.ask("prompt2");

    expect(llm.logs).toHaveLength(2);
    expect(llm.logs[0].prompt).toBe("prompt1");
    expect(llm.logs[0].response).toBe("response1");
    expect(llm.logs[0].backend).toBe("subagent");
    expect(llm.logs[1].prompt).toBe("prompt2");
    expect(llm.logs[1].response).toBe("response2");
  });

  it("should report backend type", () => {
    const runtime = makeMockRuntime([]);
    expect(new LlmHelper(runtime).backend).toBe("subagent");
    expect(new LlmHelper(null, { llmProvider: "openai" }).backend).toBe("openai");
    expect(new LlmHelper(null, { llmProvider: "anthropic" }).backend).toBe("anthropic");
    expect(new LlmHelper(null).backend).toBe("none");
  });

  it("should prefer subagent over HTTP when both available", async () => {
    const runtime = makeMockRuntime(["subagent response"]);
    const llm = new LlmHelper(runtime, {
      llmProvider: "openai",
      llmBaseUrl: "http://localhost:11434/v1",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("test");
    expect(result).toBe("subagent response");
    expect(llm.logs[0].backend).toBe("subagent");
    expect(runtime.run).toHaveBeenCalled();
  });
});

// ============================================================
// HTTP backend tests (OpenAI compatible)
// ============================================================

describe("LlmHelper HTTP — OpenAI", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should call OpenAI-compatible API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "merged result" } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      llmBaseUrl: "http://localhost:11434/v1",
      model: "llama3",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("merge these");
    expect(result).toBe("merged result");
    expect(llm.logs[0].backend).toBe("openai");

    // Verify fetch was called with correct URL and body
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("llama3");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("merge these");
  });

  it("should send API key as Bearer token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      llmApiKey: "sk-test-key",
      model: "gpt-4o-mini",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-key");
  });

  it("should use default OpenAI URL when no baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      model: "gpt-4o-mini",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("should return null on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      model: "gpt-4o-mini",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("test");
    expect(result).toBeNull();
    expect(llm.logs[0].error).toContain("500");
    expect(llm.used).toBe(1);
  });

  it("should return null on fetch exception", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      llmBaseUrl: "http://localhost:9999/v1",
      model: "llama3",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("test");
    expect(result).toBeNull();
    expect(llm.logs[0].error).toBe("ECONNREFUSED");
  });

  it("should use provider default model when config model is the subagent default", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = mockFetch;

    // model is "anthropic:claude-3-5-haiku" (the DEFAULT), but provider is "openai"
    // → should resolve to "gpt-4o-mini"
    const llm = new LlmHelper(null, {
      llmProvider: "openai",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o-mini");
  });
});

// ============================================================
// HTTP backend tests (Anthropic compatible)
// ============================================================

describe("LlmHelper HTTP — Anthropic", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should call Anthropic API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "conflict confirmed" }],
      }),
    });
    globalThis.fetch = mockFetch;

    const llm = new LlmHelper(null, {
      llmProvider: "anthropic",
      llmApiKey: "sk-ant-test",
      model: "claude-3-5-haiku-20241022",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("check conflict");
    expect(result).toBe("conflict confirmed");
    expect(llm.logs[0].backend).toBe("anthropic");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.headers["x-api-key"]).toBe("sk-ant-test");
    expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-3-5-haiku-20241022");
    expect(body.system).toBeTruthy();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("should strip provider prefix from model when using HTTP", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    });
    globalThis.fetch = mockFetch;

    // Use a non-default model with provider prefix
    const llm = new LlmHelper(null, {
      llmProvider: "anthropic",
      model: "anthropic:claude-3-haiku-20240307",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("claude-3-haiku-20240307");
  });

  it("should use default Anthropic model when config model is default", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    });
    globalThis.fetch = mockFetch;

    const llm = new LlmHelper(null, {
      llmProvider: "anthropic",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    await llm.ask("test");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("claude-3-5-haiku-20241022");
  });

  it("should handle multi-block Anthropic response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: "text", text: "YES. " },
          { type: "text", text: "They conflict." },
        ],
      }),
    });

    const llm = new LlmHelper(null, {
      llmProvider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      maxCalls: 5,
      timeoutMs: 5000,
    });

    const result = await llm.ask("test");
    expect(result).toBe("YES. They conflict.");
  });
});

// ============================================================
// Conflict detector LLM integration
// ============================================================

describe("confirmConflictsWithLlm", () => {
  it("should confirm conflict when LLM says YES", async () => {
    const runtime = makeMockRuntime(["YES. The first says use X, the second says avoid X."]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const ambiguous: AmbiguousPair[] = [
      {
        a: makeRecord("1", "We should use Redis for caching"),
        b: makeRecord("2", "We moved away from Redis to Memcached"),
        similarity: 0.70,
      },
    ];

    const result = await confirmConflictsWithLlm(ambiguous, llm);
    expect(result).toHaveLength(1);
    expect(result[0].ruleMatched).toBe("llm-confirmed");
    expect(result[0].reason).toContain("The first says use X");
  });

  it("should NOT flag when LLM says NO", async () => {
    const runtime = makeMockRuntime(["NO. These are complementary."]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const ambiguous: AmbiguousPair[] = [
      {
        a: makeRecord("1", "We use React for frontend"),
        b: makeRecord("2", "React 18 supports concurrent features"),
        similarity: 0.65,
      },
    ];

    const result = await confirmConflictsWithLlm(ambiguous, llm);
    expect(result).toHaveLength(0);
  });

  it("should return empty when llm is null", async () => {
    const result = await confirmConflictsWithLlm(
      [{ a: makeRecord("1", "a"), b: makeRecord("2", "b"), similarity: 0.7 }],
      null,
    );
    expect(result).toHaveLength(0);
  });

  it("should stop when budget exhausted", async () => {
    const runtime = makeMockRuntime(["YES. Conflict."]);
    const llm = new LlmHelper(runtime, { maxCalls: 1, timeoutMs: 5000 });

    const ambiguous: AmbiguousPair[] = [
      { a: makeRecord("1", "a"), b: makeRecord("2", "b"), similarity: 0.7 },
      { a: makeRecord("3", "c"), b: makeRecord("4", "d"), similarity: 0.7 },
    ];

    // Use up the budget on first pair
    const result = await confirmConflictsWithLlm(ambiguous, llm);
    expect(result).toHaveLength(1);
    expect(llm.exhausted).toBe(true);
  });
});

// ============================================================
// Time normalizer LLM integration
// ============================================================

describe("resolveTimeWithLlm", () => {
  it("should resolve low-confidence entries", async () => {
    const runtime = makeMockRuntime(["2026-03-15"]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const entries: TimeFixEntry[] = [
      {
        memory: makeRecord("1", "最近把 API 換成 v2"),
        original: "最近",
        resolved: "",
        newText: "最近把 API 換成 v2",
        confidence: "low",
      },
    ];

    const count = await resolveTimeWithLlm(entries, llm);
    expect(count).toBe(1);
    expect(entries[0].resolved).toBe("2026-03-15");
    expect(entries[0].confidence).toBe("high");
    expect(entries[0].newText).toBe("2026-03-15把 API 換成 v2");
  });

  it("should skip high-confidence entries", async () => {
    const runtime = makeMockRuntime([]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const entries: TimeFixEntry[] = [
      {
        memory: makeRecord("1", "昨天部署了新版"),
        original: "昨天",
        resolved: "2026-04-04",
        newText: "2026-04-04部署了新版",
        confidence: "high",
      },
    ];

    const count = await resolveTimeWithLlm(entries, llm);
    expect(count).toBe(0);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("should ignore 'unknown' response", async () => {
    const runtime = makeMockRuntime(["unknown"]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const entries: TimeFixEntry[] = [
      {
        memory: makeRecord("1", "recently updated"),
        original: "recently",
        resolved: "",
        newText: "recently updated",
        confidence: "low",
      },
    ];

    const count = await resolveTimeWithLlm(entries, llm);
    expect(count).toBe(0);
    expect(entries[0].confidence).toBe("low");
  });

  it("should return 0 when llm is null", async () => {
    const entries: TimeFixEntry[] = [
      {
        memory: makeRecord("1", "最近換了工具"),
        original: "最近",
        resolved: "",
        newText: "最近換了工具",
        confidence: "low",
      },
    ];

    const count = await resolveTimeWithLlm(entries, null);
    expect(count).toBe(0);
  });
});

// ============================================================
// Dedup merger LLM integration
// ============================================================

describe("mergeWithLlm", () => {
  it("should merge duplicate pairs", async () => {
    const runtime = makeMockRuntime(["User prefers TypeScript for all projects and components."]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const keep = makeRecord("1", "User prefers TypeScript for projects");
    const merge = makeRecord("2", "User uses TypeScript for components");
    const pairs: DedupPair[] = [
      { a: keep, b: merge, similarity: 0.92, keywordOverlap: 0.6, keep, merge },
    ];

    const results = await mergeWithLlm(pairs, llm);
    expect(results).toHaveLength(1);
    expect(results[0].keepId).toBe("1");
    expect(results[0].originalsToDelete).toEqual(["2"]);
    expect(results[0].mergedText).toContain("TypeScript");
  });

  it("should return empty when llm is null", async () => {
    const keep = makeRecord("1", "a");
    const merge = makeRecord("2", "b");
    const pairs: DedupPair[] = [
      { a: keep, b: merge, similarity: 0.92, keywordOverlap: 0.6, keep, merge },
    ];

    const results = await mergeWithLlm(pairs, null);
    expect(results).toHaveLength(0);
  });

  it("should reject excessively long merged text", async () => {
    const longResponse = "x".repeat(500);
    const runtime = makeMockRuntime([longResponse]);
    const llm = new LlmHelper(runtime, { maxCalls: 10, timeoutMs: 5000 });

    const keep = makeRecord("1", "short text");
    const merge = makeRecord("2", "other short");
    const pairs: DedupPair[] = [
      { a: keep, b: merge, similarity: 0.92, keywordOverlap: 0.6, keep, merge },
    ];

    const results = await mergeWithLlm(pairs, llm);
    // Max original len is 11, *2 = 22, but response is 500 → rejected
    expect(results).toHaveLength(0);
  });

  it("should stop when budget exhausted", async () => {
    const runtime = makeMockRuntime(["merged text"]);
    const llm = new LlmHelper(runtime, { maxCalls: 1, timeoutMs: 5000 });

    const keep = makeRecord("1", "text a that is long enough");
    const merge = makeRecord("2", "text b that is long enough");
    const pairs: DedupPair[] = [
      { a: keep, b: merge, similarity: 0.92, keywordOverlap: 0.6, keep, merge },
      { a: keep, b: merge, similarity: 0.91, keywordOverlap: 0.5, keep, merge },
    ];

    const results = await mergeWithLlm(pairs, llm);
    expect(results).toHaveLength(1);
    expect(llm.exhausted).toBe(true);
  });
});
