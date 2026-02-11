import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, LLMClientError } from '../../../src/main/services/llm-client';
import * as settingsService from '../../../src/main/services/settings';

// Save original env
const originalEnv = { ...process.env };

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLASSIFIER_LLM_PROVIDER;
  delete process.env.CLASSIFIER_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  settingsService.resetSettings();
});

afterEach(() => {
  process.env = { ...originalEnv };
  settingsService.resetSettings();
});

/**
 * Helper to create a mock Response object.
 */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('llm-client chat', () => {
  describe('Anthropic provider', () => {
    beforeEach(() => {
      settingsService.updateSettings({
        provider: 'anthropic',
        apiKeys: { anthropic: 'sk-ant-test-key' },
      });
    });

    it('should send correct request to Anthropic API and return text', async () => {
      const anthropicResponse = {
        content: [{ type: 'text', text: 'Hello from Claude!' }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(anthropicResponse));

      const result = await chat('You are helpful.', 'Say hello.');

      expect(result).toBe('Hello from Claude!');
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.method).toBe('POST');

      const headers = options.headers;
      expect(headers['x-api-key']).toBe('sk-ant-test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('claude-3-5-haiku-latest');
      expect(body.system).toBe('You are helpful.');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello.' }]);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0);
    });

    it('should use custom model and options when provided', async () => {
      const anthropicResponse = {
        content: [{ type: 'text', text: 'response' }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(anthropicResponse));

      await chat('sys', 'user', {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 1024,
        temperature: 0.5,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.5);
    });

    it('should throw INVALID_RESPONSE when content array is missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 'msg_123' }));

      try {
        await chat('sys', 'user');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('INVALID_RESPONSE');
        expect((err as LLMClientError).message).toContain(
          'Anthropic response missing content array'
        );
      }
    });

    it('should throw INVALID_RESPONSE when no text block is found', async () => {
      const resp = { content: [{ type: 'image', source: {} }] };
      mockFetch.mockResolvedValueOnce(mockResponse(resp));

      await expect(chat('sys', 'user')).rejects.toThrow(
        'Anthropic response missing text block'
      );
    });
  });

  describe('OpenAI provider', () => {
    beforeEach(() => {
      settingsService.updateSettings({
        provider: 'openai',
        model: 'gpt-4o',
        apiKeys: { openai: 'sk-openai-test-key' },
      });
    });

    it('should send correct request to OpenAI API and return text', async () => {
      const openAIResponse = {
        choices: [{ message: { content: 'Hello from GPT!' } }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(openAIResponse));

      const result = await chat('You are helpful.', 'Say hello.');

      expect(result).toBe('Hello from GPT!');
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');

      const headers = options.headers;
      expect(headers['Authorization']).toBe('Bearer sk-openai-test-key');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Say hello.' },
      ]);
    });

    it('should throw INVALID_RESPONSE when choices array is empty', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ choices: [] }));

      await expect(chat('sys', 'user')).rejects.toThrow(
        'OpenAI response missing choices array'
      );
    });

    it('should throw INVALID_RESPONSE when message content is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ choices: [{ message: {} }] })
      );

      await expect(chat('sys', 'user')).rejects.toThrow(
        'OpenAI response missing message content'
      );
    });
  });

  describe('OpenRouter provider', () => {
    beforeEach(() => {
      settingsService.updateSettings({
        provider: 'openrouter',
        model: 'claude-3-5-haiku-latest',
        apiKeys: { openrouter: 'sk-or-test-key' },
      });
    });

    it('should send correct request to OpenRouter API with extra headers', async () => {
      const openRouterResponse = {
        choices: [{ message: { content: 'Hello from OpenRouter!' } }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(openRouterResponse));

      const result = await chat('You are helpful.', 'Say hello.');

      expect(result).toBe('Hello from OpenRouter!');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');

      const headers = options.headers;
      expect(headers['Authorization']).toBe('Bearer sk-or-test-key');
      expect(headers['HTTP-Referer']).toBe('https://colab-ap-classifier.app');
      expect(headers['X-Title']).toBe('colab-ap-classifier');

      // Should use OpenAI message format
      const body = JSON.parse(options.body);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
    });
  });

  describe('provider override via options', () => {
    it('should use the provider specified in options instead of settings', async () => {
      // Default provider is anthropic, but we override to openai
      settingsService.updateSettings({
        apiKeys: { openai: 'sk-openai-override' },
      });

      const openAIResponse = {
        choices: [{ message: { content: 'Overridden!' } }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(openAIResponse));

      const result = await chat('sys', 'user', { provider: 'openai', model: 'gpt-4o' });

      expect(result).toBe('Overridden!');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });
  });

  describe('error handling', () => {
    it('should throw MISSING_API_KEY when no API key is available', async () => {
      // No API key set for anthropic
      await expect(chat('sys', 'user')).rejects.toThrow(LLMClientError);

      try {
        await chat('sys', 'user');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('MISSING_API_KEY');
      }
    });

    it('should throw API_ERROR when provider is unknown', async () => {
      try {
        await chat('sys', 'user', { provider: 'nonexistent' });
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('API_ERROR');
        expect((err as LLMClientError).message).toContain('Unknown provider');
      }
    });

    it('should throw API_ERROR on non-OK HTTP response', async () => {
      settingsService.updateSettings({
        apiKeys: { anthropic: 'sk-ant-test' },
      });
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: { message: 'Rate limited' } }, 429)
      );

      try {
        await chat('sys', 'user');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('API_ERROR');
        expect((err as LLMClientError).statusCode).toBe(429);
      }
    });

    it('should throw TIMEOUT when the request is aborted', async () => {
      settingsService.updateSettings({
        apiKeys: { anthropic: 'sk-ant-test' },
      });

      mockFetch.mockImplementationOnce(() => {
        const err = new DOMException('The operation was aborted.', 'AbortError');
        return Promise.reject(err);
      });

      try {
        await chat('sys', 'user');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('TIMEOUT');
      }
    });

    it('should throw API_ERROR on network failure', async () => {
      settingsService.updateSettings({
        apiKeys: { anthropic: 'sk-ant-test' },
      });

      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await chat('sys', 'user');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('API_ERROR');
        expect((err as LLMClientError).message).toContain('ECONNREFUSED');
      }
    });

    it('should throw INVALID_RESPONSE when JSON parsing fails', async () => {
      settingsService.updateSettings({
        apiKeys: { anthropic: 'sk-ant-test' },
      });

      const badResponse = {
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        text: vi.fn().mockResolvedValue('not json'),
      } as unknown as Response;
      mockFetch.mockResolvedValueOnce(badResponse);

      try {
        await chat('sys', 'user');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMClientError);
        expect((err as LLMClientError).code).toBe('INVALID_RESPONSE');
      }
    });
  });
});
