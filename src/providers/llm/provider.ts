import { LLMError } from "../../lib/errors";
import { Logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limiter";

interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
}

// Cost per 1K tokens (input/output) by model prefix
const COST_TABLE: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet": { input: 0.003, output: 0.015 },
  "anthropic/claude-haiku": { input: 0.00025, output: 0.00125 },
  "anthropic/claude-opus": { input: 0.015, output: 0.075 },
  "openai/gpt-4o": { input: 0.0025, output: 0.01 },
  "openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "deepseek/deepseek-chat": { input: 0.00014, output: 0.00028 },
};

export class LLMProvider {
  private readonly anthropicKey?: string;
  private readonly openaiKey?: string;
  private readonly openaiBaseUrl: string;
  private readonly logger: Logger;
  private readonly rateLimiter: RateLimiter;

  private totalCost = 0;
  private totalCalls = 0;

  constructor(
    logger: Logger,
    config: {
      anthropicKey?: string;
      openaiKey?: string;
      openaiBaseUrl?: string;
    },
  ) {
    this.logger = logger;
    this.anthropicKey = config.anthropicKey;
    this.openaiKey = config.openaiKey;
    this.openaiBaseUrl = config.openaiBaseUrl ?? "https://api.openai.com";
    // Anthropic allows ~50 RPM on most tiers; be conservative
    this.rateLimiter = new RateLimiter({ maxRequests: 40, windowMs: 60_000 });
  }

  async complete(
    system: string,
    user: string,
    model: string,
    opts?: LLMOptions,
  ): Promise<LLMResponse> {
    const maxTokens = opts?.maxTokens ?? 2048;
    const temperature = opts?.temperature ?? 0.3;

    await this.rateLimiter.waitForSlot();
    this.rateLimiter.record();

    let response: LLMResponse;

    if (model.startsWith("anthropic/")) {
      response = await this.callAnthropic(system, user, model, maxTokens, temperature);
    } else {
      response = await this.callOpenAICompatible(system, user, model, maxTokens, temperature);
    }

    const cost = this.estimateCost(model, response.inputTokens, response.outputTokens);
    this.totalCost += cost;
    this.totalCalls++;

    this.logger.debug("llm", "Completion", {
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cost: cost.toFixed(6),
    });

    return response;
  }

  private async callAnthropic(
    system: string,
    user: string,
    model: string,
    maxTokens: number,
    temperature: number,
  ): Promise<LLMResponse> {
    if (!this.anthropicKey) throw new LLMError("Anthropic API key not configured");

    const modelId = model.replace("anthropic/", "");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMError(`Anthropic API returned ${response.status}: ${text}`, response.status);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      content: data.content[0]?.text ?? "",
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }

  private async callOpenAICompatible(
    system: string,
    user: string,
    model: string,
    maxTokens: number,
    temperature: number,
  ): Promise<LLMResponse> {
    if (!this.openaiKey) throw new LLMError("OpenAI API key not configured");

    const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;

    const response = await fetch(`${this.openaiBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMError(`OpenAI API returned ${response.status}: ${text}`, response.status);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: data.model,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    };
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const entry = Object.entries(COST_TABLE).find(([prefix]) => model.startsWith(prefix));
    if (!entry) return 0;

    const [, rates] = entry;
    return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
  }

  get stats() {
    return {
      totalCost: this.totalCost,
      totalCalls: this.totalCalls,
      avgCostPerCall: this.totalCalls > 0 ? this.totalCost / this.totalCalls : 0,
    };
  }
}

/** Best-effort parse of a JSON object out of an LLM completion (handles ```json fences). */
export function parseLLMResponse<T>(content: string): T | null {
  if (!content) return null;
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
