// OpenRouter 共用 client。專案內所有文字 LLM 都從這裡走，避免
// chat / styleTagger 各自實作一份、之後又出現 provider 不一致。

export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.8-27b:free";
export const OPENROUTER_FREE_FALLBACK_MODEL = "openrouter/free";

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: unknown;
};

export type OpenRouterResult =
  | { content: string; reason: "ok"; model: string | null }
  | { content: null; reason: string; model: string | null };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: string; text?: string };
      return value.type === "text" ? (value.text ?? "") : "";
    })
    .join("");
}

/**
 * 指定的免費 endpoint 可能遇到 rate limit，所以同一個 request 會把
 * openrouter/free 放在第二順位。這個 router 仍只會選免費模型，並且會
 * 根據 request 是否含圖片自動排除不支援 vision 的模型。
 */
export function openRouterModels(model?: string): string[] {
  const primary = model?.trim() || process.env.OPENROUTER_MODEL?.trim() ||
    process.env.CHAT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  return [...new Set([primary, OPENROUTER_FREE_FALLBACK_MODEL])];
}

export async function callOpenRouter(options: {
  messages: OpenRouterMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /**
   * App 內的工作都是分類、JSON 或短文，不需要讓 reasoning model 長考。
   * Qwen3.8 預設會開 reasoning；若不關掉，它可能先耗完 max_tokens，
   * 最後只留下 finish_reason=length 而沒有可用的答案。
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "max";
}): Promise<OpenRouterResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      content: null,
      reason: "NO_API_KEY: OPENROUTER_API_KEY 未設定",
      model: null,
    };
  }

  const models = openRouterModels(options.model);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? Number(process.env.CHAT_TIMEOUT_MS || 8000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "WowStylist",
    };
    const referer = process.env.SITE_URL?.trim();
    if (referer) headers["HTTP-Referer"] = referer;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        models,
        messages: options.messages,
        max_tokens: options.maxTokens ?? 400,
        temperature: options.temperature ?? 0,
        reasoning: { effort: options.reasoningEffort ?? "none" },
      }),
    });

    const elapsed = Date.now() - startedAt;
    const raw = await res.text();
    let data: {
      error?: { code?: number | string; message?: string };
      model?: string;
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: unknown };
      }>;
    } = {};
    try {
      data = JSON.parse(raw);
    } catch {
      // 下面統一當作無法解讀的回應。
    }

    if (!res.ok || data.error) {
      const code = data.error?.code ?? res.status;
      const detail = data.error?.message ?? raw.slice(0, 300) ?? "unknown error";
      return {
        content: null,
        reason: `HTTP_${code} (${elapsed}ms): ${detail}`,
        model: data.model ?? null,
      };
    }

    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      return {
        content: null,
        reason: `TRUNCATED finish_reason=length (${elapsed}ms)`,
        model: data.model ?? null,
      };
    }

    const content = contentToText(choice?.message?.content).trim();
    if (!content) {
      return {
        content: null,
        reason: `EMPTY_CONTENT (${elapsed}ms): ${raw.slice(0, 200)}`,
        model: data.model ?? null,
      };
    }

    return { content, reason: "ok", model: data.model ?? null };
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const reason = error instanceof Error && error.name === "AbortError"
      ? `TIMEOUT >${elapsed}ms`
      : `NETWORK_ERROR (${elapsed}ms): ${String(error)}`;
    return { content: null, reason, model: null };
  } finally {
    clearTimeout(timer);
  }
}
