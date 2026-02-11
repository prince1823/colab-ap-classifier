import * as settingsService from './settings';

/**
 * Options for LLM chat calls.
 */
export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  provider?: string;
}

/**
 * Error thrown when the LLM client encounters a problem.
 */
export class LLMClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MISSING_API_KEY'
      | 'INVALID_RESPONSE'
      | 'TIMEOUT'
      | 'API_ERROR',
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'LLMClientError';
  }
}

/**
 * Provider endpoint configuration.
 */
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
    defaultModel: 'gpt-4o',
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

/**
 * Build the request body for the Anthropic API format.
 */
function buildAnthropicBody(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  temperature: number
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
}

/**
 * Build the request body for the OpenAI / OpenRouter API format.
 */
function buildOpenAIBody(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  temperature: number
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}

/**
 * Build request headers for the given provider.
 */
function buildHeaders(
  provider: string,
  apiKey: string,
  format: 'anthropic' | 'openai'
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

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

/**
 * Extract the text content from an Anthropic API response.
 */
function extractAnthropicText(data: unknown): string {
  const resp = data as {
    content?: Array<{ type: string; text: string }>;
  };
  if (!resp.content || !Array.isArray(resp.content) || resp.content.length === 0) {
    throw new LLMClientError(
      'Anthropic response missing content array',
      'INVALID_RESPONSE'
    );
  }
  const textBlock = resp.content.find((block) => block.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new LLMClientError(
      'Anthropic response missing text block',
      'INVALID_RESPONSE'
    );
  }
  return textBlock.text;
}

/**
 * Extract the text content from an OpenAI / OpenRouter API response.
 */
function extractOpenAIText(data: unknown): string {
  const resp = data as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!resp.choices || !Array.isArray(resp.choices) || resp.choices.length === 0) {
    throw new LLMClientError(
      'OpenAI response missing choices array',
      'INVALID_RESPONSE'
    );
  }
  const content = resp.choices[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMClientError(
      'OpenAI response missing message content',
      'INVALID_RESPONSE'
    );
  }
  return content;
}

/**
 * Send a chat message to an LLM provider and return the response text.
 *
 * @param systemPrompt - The system prompt to set context
 * @param userPrompt - The user message to send
 * @param options - Optional overrides for model, max tokens, temperature, and provider
 * @returns The LLM response text
 */
export async function chat(
  systemPrompt: string,
  userPrompt: string,
  options?: ChatOptions
): Promise<string> {
  const settings = settingsService.getSettings();
  const provider = options?.provider ?? settings.provider;
  const config = PROVIDER_CONFIGS[provider];

  if (!config) {
    throw new LLMClientError(
      `Unknown provider: ${provider}`,
      'API_ERROR'
    );
  }

  const apiKey = settingsService.getApiKey(provider);
  if (!apiKey) {
    throw new LLMClientError(
      `No API key configured for provider "${provider}". Set it in Settings or via environment variable.`,
      'MISSING_API_KEY'
    );
  }

  const model = options?.model ?? settings.model ?? config.defaultModel;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;

  const body =
    config.format === 'anthropic'
      ? buildAnthropicBody(systemPrompt, userPrompt, model, maxTokens, temperature)
      : buildOpenAIBody(systemPrompt, userPrompt, model, maxTokens, temperature);

  const headers = buildHeaders(provider, apiKey, config.format);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LLMClientError(
        `Request to ${provider} timed out after ${REQUEST_TIMEOUT_MS}ms`,
        'TIMEOUT'
      );
    }
    throw new LLMClientError(
      `Network error calling ${provider}: ${error instanceof Error ? error.message : String(error)}`,
      'API_ERROR'
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // ignore read errors on error responses
    }
    throw new LLMClientError(
      `${provider} API returned HTTP ${response.status}: ${errorBody}`,
      'API_ERROR',
      response.status
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new LLMClientError(
      `Failed to parse JSON response from ${provider}`,
      'INVALID_RESPONSE'
    );
  }

  return config.format === 'anthropic'
    ? extractAnthropicText(data)
    : extractOpenAIText(data);
}
