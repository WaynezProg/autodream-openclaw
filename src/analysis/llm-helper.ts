/**
 * LLM Helper — supports multiple backends for lightweight inference calls.
 *
 * Backends (in priority order):
 * 1. OpenClaw subagent runtime (when available)
 * 2. Direct HTTP calls to OpenAI-compatible or Anthropic-compatible APIs
 *
 * Design:
 * - Rate-limited per dream run (default 10 calls max)
 * - Timeout per call (default 5 000 ms)
 * - Graceful fallback: returns null when budget exhausted or on error
 */

export type LlmProvider = "openai" | "anthropic";

export interface LlmHelperConfig {
  /** Model identifier — for subagent: "provider:model", for HTTP: just the model name */
  model: string;
  /** Maximum LLM calls allowed per dream run */
  maxCalls: number;
  /** Timeout in ms for each call */
  timeoutMs: number;
  /** LLM provider for direct HTTP calls (default: "anthropic") */
  llmProvider?: LlmProvider;
  /** Base URL for the API (e.g. "http://localhost:11434/v1" for Ollama) */
  llmBaseUrl?: string;
  /** API key for cloud providers (optional for local models) */
  llmApiKey?: string;
}

export const DEFAULT_LLM_CONFIG: LlmHelperConfig = {
  model: "gpt-4o",
  maxCalls: 10,
  timeoutMs: 5_000,
  llmProvider: "openai",
};

/** Provider-specific default models */
const PROVIDER_DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-4o-mini",
};

/** Provider-specific default base URLs */
const PROVIDER_DEFAULT_URLS: Record<LlmProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/** Minimal interface matching OpenClaw's subagent runtime API */
export interface SubagentRuntime {
  run(opts: {
    sessionKey: string;
    message: string;
    model?: string;
    provider?: string;
    extraSystemPrompt?: string;
  }): Promise<{ runId: string }>;

  waitForRun(opts: {
    runId: string;
    timeoutMs?: number;
  }): Promise<{
    status: "ok" | "error" | "timeout";
    payloads?: Array<{ text?: string }>;
  }>;
}

export interface LlmCallLog {
  prompt: string;
  response: string | null;
  durationMs: number;
  backend?: "subagent" | "openai" | "anthropic";
  error?: string;
}

export class LlmHelper {
  private callCount = 0;
  private readonly config: LlmHelperConfig;
  private readonly runtime: SubagentRuntime | null;
  readonly logs: LlmCallLog[] = [];

  constructor(
    runtime: SubagentRuntime | null,
    config?: Partial<LlmHelperConfig>,
  ) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
    this.runtime = runtime;
  }

  /** Number of LLM calls made so far */
  get used(): number {
    return this.callCount;
  }

  /** Remaining call budget */
  get remaining(): number {
    return Math.max(0, this.config.maxCalls - this.callCount);
  }

  /** Whether the call budget is exhausted */
  get exhausted(): boolean {
    return this.callCount >= this.config.maxCalls;
  }

  /** Which backend will be used */
  get backend(): "subagent" | "openai" | "anthropic" | "none" {
    if (this.runtime) return "subagent";
    if (this.config.llmProvider) return this.config.llmProvider;
    return "none";
  }

  /**
   * Send a prompt and return the text response.
   * Returns null if budget exhausted, no backend available, timeout, or error.
   */
  async ask(prompt: string, systemPrompt?: string): Promise<string | null> {
    const defaultSystem =
      "You are a concise analysis assistant. Answer directly with no preamble.";

    // Check for available backend
    if (!this.runtime && !this.config.llmProvider) {
      this.logs.push({ prompt, response: null, durationMs: 0, error: "no runtime" });
      return null;
    }

    if (this.exhausted) {
      this.logs.push({ prompt, response: null, durationMs: 0, error: "budget exhausted" });
      return null;
    }

    this.callCount++;

    // Route to appropriate backend
    if (this.runtime) {
      return this.askSubagent(prompt, systemPrompt ?? defaultSystem);
    }
    return this.askHttp(prompt, systemPrompt ?? defaultSystem);
  }

  // ── Subagent backend (OpenClaw runtime) ──────────────────────

  private async askSubagent(
    prompt: string,
    systemPrompt: string,
  ): Promise<string | null> {
    const start = Date.now();
    const [provider, model] = this.parseModel(this.config.model);

    try {
      const { runId } = await this.runtime!.run({
        sessionKey: `autodream-llm-${Date.now()}-${this.callCount}`,
        message: prompt,
        provider,
        model,
        extraSystemPrompt: systemPrompt,
      });

      const result = await this.runtime!.waitForRun({
        runId,
        timeoutMs: this.config.timeoutMs,
      });

      const durationMs = Date.now() - start;

      if (result.status !== "ok") {
        this.logs.push({
          prompt, response: null, durationMs,
          backend: "subagent", error: `status: ${result.status}`,
        });
        return null;
      }

      const text = result.payloads
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("")
        .trim() ?? null;

      this.logs.push({ prompt, response: text, durationMs, backend: "subagent" });
      return text || null;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logs.push({
        prompt, response: null, durationMs,
        backend: "subagent", error: errorMsg,
      });
      return null;
    }
  }

  // ── HTTP backend (OpenAI / Anthropic compatible) ─────────────

  private async askHttp(
    prompt: string,
    systemPrompt: string,
  ): Promise<string | null> {
    const provider = this.config.llmProvider!;
    const start = Date.now();

    try {
      const text = provider === "anthropic"
        ? await this.callAnthropic(prompt, systemPrompt)
        : await this.callOpenAI(prompt, systemPrompt);

      const durationMs = Date.now() - start;
      this.logs.push({ prompt, response: text, durationMs, backend: provider });
      return text || null;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logs.push({
        prompt, response: null, durationMs,
        backend: provider, error: errorMsg,
      });
      return null;
    }
  }

  private resolveModel(): string {
    const provider = this.config.llmProvider!;
    const model = this.config.model;

    // If model is the subagent-style default, use provider-specific default
    if (model === DEFAULT_LLM_CONFIG.model) {
      return PROVIDER_DEFAULT_MODELS[provider];
    }

    // If model contains ":", strip the provider prefix
    if (model.includes(":")) {
      return model.split(":", 2)[1];
    }

    return model;
  }

  private resolveBaseUrl(): string {
    const provider = this.config.llmProvider!;
    return this.config.llmBaseUrl ?? PROVIDER_DEFAULT_URLS[provider];
  }

  private async callOpenAI(
    prompt: string,
    systemPrompt: string,
  ): Promise<string | null> {
    const baseUrl = this.resolveBaseUrl();
    const model = this.resolveModel();
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = this.config.llmApiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return json.choices?.[0]?.message?.content?.trim() ?? null;
  }

  private async callAnthropic(
    prompt: string,
    systemPrompt: string,
  ): Promise<string | null> {
    const baseUrl = this.resolveBaseUrl();
    const model = this.resolveModel();
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    const apiKey = this.config.llmApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const body = JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API error: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    return json.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim() ?? null;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private parseModel(modelStr: string): [string | undefined, string | undefined] {
    if (modelStr.includes(":")) {
      const [provider, model] = modelStr.split(":", 2);
      return [provider, model];
    }
    return [undefined, modelStr];
  }
}
