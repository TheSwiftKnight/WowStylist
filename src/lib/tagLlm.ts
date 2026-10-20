import {
  callOpenRouter,
  type OpenRouterMessage,
} from "@/lib/openrouter";

export const DEFAULT_TAG_OPENROUTER_MODEL =
  "minimax/minimax-m3.1-flash:free";
export const DEFAULT_TAG_OPENAI_MODEL = "gpt-5.4-mini";

type ParsedResult<T> = {
  value: T | null;
  provider: "openrouter" | "openai" | null;
  model: string | null;
  reason: string;
};

function outputText(payload: {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}): string {
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

async function callOpenAIForTags(options: {
  messages: OpenRouterMessage[];
  maxTokens: number;
}): Promise<{ content: string | null; model: string | null; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { content: null, model: null, reason: "NO_API_KEY: OPENAI_API_KEY 未設定" };
  }

  const model =
    process.env.TAG_OPENAI_MODEL?.trim() || DEFAULT_TAG_OPENAI_MODEL;

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: options.messages.map((message) => ({
          role: message.role === "system" ? "developer" : message.role,
          content:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
        })),
        max_output_tokens: options.maxTokens,
        reasoning: { effort: "none" },
        text: { verbosity: "low" },
        store: false,
      }),
      signal: AbortSignal.timeout(
        Number(process.env.TAG_OPENAI_TIMEOUT_MS || 20_000)
      ),
    });

    const raw = await res.text();
    let data: {
      model?: string;
      error?: { message?: string };
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      return {
        content: null,
        model,
        reason: `NON_JSON HTTP_${res.status}: ${raw.slice(0, 240)}`,
      };
    }

    if (!res.ok || data.error) {
      return {
        content: null,
        model: data.model ?? model,
        reason: `HTTP_${res.status}: ${data.error?.message ?? raw.slice(0, 240)}`,
      };
    }

    const content = outputText(data);
    return content
      ? { content, model: data.model ?? model, reason: "ok" }
      : { content: null, model: data.model ?? model, reason: "EMPTY_CONTENT" };
  } catch (error) {
    return {
      content: null,
      model,
      reason: `FETCH_ERROR: ${String(error)}`,
    };
  }
}

/**
 * Tag 工作固定先用已實測可回 JSON 的 OpenRouter 免費模型。
 * HTTP/timeout/空內容，以及「有內容但 parse 不合格」，都會再試 OpenAI。
 */
export async function callTagLlm<T>(options: {
  messages: OpenRouterMessage[];
  parse: (text: string) => T | null;
  maxTokens?: number;
}): Promise<ParsedResult<T>> {
  const maxTokens = options.maxTokens ?? 800;
  const openRouterModel =
    process.env.TAG_OPENROUTER_MODEL?.trim() ||
    process.env.TAG_MODEL?.trim() ||
    DEFAULT_TAG_OPENROUTER_MODEL;

  const openRouter = await callOpenRouter({
    model: openRouterModel,
    messages: options.messages,
    maxTokens,
    temperature: 0,
    timeoutMs: Number(process.env.TAG_OPENROUTER_TIMEOUT_MS || 20_000),
    reasoningEffort: "minimal",
    includeFreeRouterFallback: false,
  });

  if (openRouter.content) {
    const value = options.parse(openRouter.content);
    if (value !== null) {
      return {
        value,
        provider: "openrouter",
        model: openRouter.model ?? openRouterModel,
        reason: "ok",
      };
    }
  }

  const openRouterReason = openRouter.content
    ? "INVALID_RESPONSE"
    : openRouter.reason;
  console.warn(
    `[tagLlm] OpenRouter ${openRouterModel} 失敗（${openRouterReason}），改試 OpenAI`
  );

  const openAI = await callOpenAIForTags({
    messages: options.messages,
    maxTokens,
  });
  if (openAI.content) {
    const value = options.parse(openAI.content);
    if (value !== null) {
      return {
        value,
        provider: "openai",
        model: openAI.model,
        reason: "ok",
      };
    }
  }

  return {
    value: null,
    provider: openAI.model ? "openai" : null,
    model: openAI.model,
    reason: openAI.content ? "INVALID_RESPONSE" : openAI.reason,
  };
}
