import type { LLMClient, ILLMConfig } from '../../shared/types/services';
import { debugLog } from '../utils/debug-log';

interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  provider?: string;
}

export class LLMClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'MISSING_API_KEY' | 'INVALID_RESPONSE' | 'TIMEOUT' | 'API_ERROR',
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'LLMClientError';
  }
}

interface ProviderConfig {
  url: string;
  format: 'anthropic' | 'openai';
  defaultModel: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    format: 'anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    format: 'openai',
    defaultModel: 'gpt-4o-mini',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    format: 'openai',
    defaultModel: 'claude-3-5-haiku-latest',
  },
};

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 6;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Minimal env-only config used by the backward-compat standalone chat() function.
 * In production, AppConfigService (which also reads a persisted config file) is injected.
 */
class EnvLLMConfig implements ILLMConfig {
  getApiKey(provider: string): string | null {
    switch (provider) {
      case 'anthropic': return process.env.ANTHROPIC_API_KEY || null;
      case 'openai':    return process.env.OPENAI_API_KEY || null;
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || null;
      default:          return null;
    }
  }
  async setApiKey(): Promise<void> {}
  getProvider(): string { return process.env.CLASSIFIER_LLM_PROVIDER || 'openrouter'; }
  async setProvider(): Promise<void> {}
  getModel(): string { return process.env.CLASSIFIER_MODEL || 'claude-3-5-haiku-latest'; }
  async setModel(): Promise<void> {}
}

function isRetryableStatus(status: number, errorBody?: string): boolean {
  if (status >= 500) return true;
  if (status === 429) {
    if (errorBody && isQuotaExhausted(errorBody)) return false;
    return true;
  }
  return false;
}

function isQuotaExhausted(errorBody: string): boolean {
  const lower = errorBody.toLowerCase();
  return lower.includes('insufficient_quota') || lower.includes('exceeded your current quota');
}

function retryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
  }
  const base = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.25;
  return Math.min(base + jitter, MAX_RETRY_DELAY_MS);
}

function buildAnthropicBody(systemPrompt: string, userPrompt: string, model: string, maxTokens: number, temperature: number): object {
  return { model, max_tokens: maxTokens, temperature, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] };
}

function buildOpenAIBody(systemPrompt: string, userPrompt: string, model: string, maxTokens: number, temperature: number): object {
  return { model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] };
}

function buildHeaders(provider: string, apiKey: string, format: 'anthropic' | 'openai'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (format === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://colab-ap-classifier.app';
    headers['X-Title'] = 'colab-ap-classifier';
  }
  return headers;
}

function extractAnthropicText(data: unknown): string {
  const resp = data as { content?: Array<{ type: string; text: string }> };
  if (!resp.content || !Array.isArray(resp.content) || resp.content.length === 0) {
    throw new LLMClientError('Anthropic response missing content array', 'INVALID_RESPONSE');
  }
  const textBlock = resp.content.find((block) => block.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new LLMClientError('Anthropic response missing text block', 'INVALID_RESPONSE');
  }
  return textBlock.text;
}

function extractOpenAIText(data: unknown): string {
  const resp = data as { choices?: Array<{ message?: { content?: string } }> };
  if (!resp.choices || !Array.isArray(resp.choices) || resp.choices.length === 0) {
    throw new LLMClientError('OpenAI response missing choices array', 'INVALID_RESPONSE');
  }
  const content = resp.choices[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMClientError('OpenAI response missing message content', 'INVALID_RESPONSE');
  }
  return content;
}

export class OpenRouterLLMClient implements LLMClient {
  constructor(private readonly configService: ILLMConfig = new EnvLLMConfig()) {}

  async chat(systemPrompt: string, userPrompt: string, options?: ChatOptions): Promise<string> {
    const provider = options?.provider ?? this.configService.getProvider();
    const config = PROVIDER_CONFIGS[provider];

    if (!config) {
      throw new LLMClientError(`Unknown provider: ${provider}`, 'API_ERROR');
    }

    const apiKey = this.configService.getApiKey(provider);
    if (!apiKey) {
      debugLog('ERROR', `[LLM] No API key for provider="${provider}"`);
      throw new LLMClientError(`No API key configured for provider "${provider}". Set the appropriate environment variable in .env.`, 'MISSING_API_KEY');
    }

    const model = options?.model ?? this.configService.getModel() ?? config.defaultModel;
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;

    const body = config.format === 'anthropic'
      ? buildAnthropicBody(systemPrompt, userPrompt, model, maxTokens, temperature)
      : buildOpenAIBody(systemPrompt, userPrompt, model, maxTokens, temperature);

    const headers = buildHeaders(provider, apiKey, config.format);
    debugLog('INFO', `[LLM] chat provider=${provider} model=${model}`);
    let lastError: LLMClientError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const t0 = Date.now();

      debugLog('INFO', `[LLM] fetch attempt=${attempt + 1}/${MAX_RETRIES + 1} url=${config.url}`);
      let response: Response;
      try {
        response = await fetch(config.url, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        });
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        const msg = error instanceof DOMException && error.name === 'AbortError'
          ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `network error: ${error instanceof Error ? error.message : String(error)}`;
        debugLog('ERROR', `[LLM] fetch failed attempt=${attempt + 1} ${msg}`);
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new LLMClientError(`Request to ${provider} timed out after ${REQUEST_TIMEOUT_MS}ms`, 'TIMEOUT');
        }
        throw new LLMClientError(`Network error calling ${provider}: ${error instanceof Error ? error.message : String(error)}`, 'API_ERROR');
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch { /* ignore */ }

        if (isRetryableStatus(response.status, errorBody) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt, response.headers.get('retry-after'));
          debugLog('WARN', `[LLM] HTTP ${response.status} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, errorBody.slice(0, 200));
          console.warn(`[LLM] ${provider} returned HTTP ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          lastError = new LLMClientError(`${provider} API returned HTTP ${response.status}: ${errorBody}`, 'API_ERROR', response.status);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        debugLog('ERROR', `[LLM] HTTP ${response.status} non-retryable`, errorBody.slice(0, 400));
        throw new LLMClientError(`${provider} API returned HTTP ${response.status}: ${errorBody}`, 'API_ERROR', response.status);
      }

      let data: unknown;
      try { data = await response.json(); } catch {
        debugLog('ERROR', '[LLM] failed to parse JSON response');
        throw new LLMClientError(`Failed to parse JSON response from ${provider}`, 'INVALID_RESPONSE');
      }

      debugLog('INFO', `[LLM] success attempt=${attempt + 1} (${Date.now() - t0}ms)`);
      return config.format === 'anthropic' ? extractAnthropicText(data) : extractOpenAIText(data);
    }

    debugLog('ERROR', `[LLM] exhausted all ${MAX_RETRIES} retries`);
    throw lastError ?? new LLMClientError(`${provider} API failed after ${MAX_RETRIES} retries`, 'API_ERROR');
  }
}

// Backward compatibility: export standalone chat function
export async function chat(systemPrompt: string, userPrompt: string, options?: ChatOptions): Promise<string> {
  const client = new OpenRouterLLMClient();
  return client.chat(systemPrompt, userPrompt, options);
}
