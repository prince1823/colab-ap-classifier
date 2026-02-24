import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSettings,
  updateSettings,
  getModels,
  getProviders,
  getApiKey,
  resetSettings,
} from '../../../src/main/services/settings';

// Save original env vars so we can restore them
const originalEnv = { ...process.env };

beforeEach(() => {
  // Clear env vars that affect settings
  delete process.env.CLASSIFIER_LLM_PROVIDER;
  delete process.env.CLASSIFIER_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  resetSettings();
});

afterEach(() => {
  // Restore original env vars
  process.env = { ...originalEnv };
  resetSettings();
});

describe('getSettings', () => {
  it('should return default settings when no env vars are set', () => {
    const settings = getSettings();

    expect(settings.provider).toBe('anthropic');
    expect(settings.model).toBe('claude-3-5-haiku-latest');
    expect(settings.hasApiKey).toBe(false);
    expect(settings.availableProviders).toEqual(['anthropic', 'openai', 'openrouter']);
  });

  it('should read provider from CLASSIFIER_LLM_PROVIDER env var', () => {
    process.env.CLASSIFIER_LLM_PROVIDER = 'openai';
    resetSettings();

    const settings = getSettings();
    expect(settings.provider).toBe('openai');
  });

  it('should read model from CLASSIFIER_MODEL env var', () => {
    process.env.CLASSIFIER_MODEL = 'gpt-4o';
    resetSettings();

    const settings = getSettings();
    expect(settings.model).toBe('gpt-4o');
  });

  it('should report hasApiKey true when env var key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    resetSettings();

    const settings = getSettings();
    expect(settings.hasApiKey).toBe(true);
  });

  it('should report hasApiKey false when no key available for provider', () => {
    const settings = getSettings();
    expect(settings.hasApiKey).toBe(false);
  });
});

describe('updateSettings', () => {
  it('should update the provider', () => {
    updateSettings({ provider: 'openai' });

    const settings = getSettings();
    expect(settings.provider).toBe('openai');
  });

  it('should update the model', () => {
    updateSettings({ model: 'claude-sonnet-4-20250514' });

    const settings = getSettings();
    expect(settings.model).toBe('claude-sonnet-4-20250514');
  });

  it('should update both provider and model simultaneously', () => {
    updateSettings({ provider: 'openai', model: 'gpt-4o' });

    const settings = getSettings();
    expect(settings.provider).toBe('openai');
    expect(settings.model).toBe('gpt-4o');
  });

  it('should store API keys in memory', () => {
    updateSettings({ apiKeys: { anthropic: 'sk-mem-key' } });

    expect(getApiKey('anthropic')).toBe('sk-mem-key');
  });

  it('should throw on unknown provider', () => {
    expect(() => updateSettings({ provider: 'unknown-provider' })).toThrow(
      'Unknown provider: unknown-provider'
    );
  });

  it('should update hasApiKey after setting a key', () => {
    expect(getSettings().hasApiKey).toBe(false);

    updateSettings({ apiKeys: { anthropic: 'sk-test' } });

    expect(getSettings().hasApiKey).toBe(true);
  });
});

describe('getModels', () => {
  it('should return anthropic models by default', () => {
    const models = getModels();

    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual([
      'claude-3-5-haiku-latest',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
    ]);
  });

  it('should return openai models when provider is openai', () => {
    updateSettings({ provider: 'openai' });

    const models = getModels();

    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
    ]);
  });

  it('should return all models for openrouter', () => {
    updateSettings({ provider: 'openrouter' });

    const models = getModels();

    expect(models).toHaveLength(6);
    expect(models.map((m) => m.id)).toContain('claude-3-5-haiku-latest');
    expect(models.map((m) => m.id)).toContain('gpt-4o');
  });
});

describe('getProviders', () => {
  it('should return all three providers', () => {
    const providers = getProviders();

    expect(providers).toHaveLength(3);
    expect(providers).toEqual([
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'openrouter', name: 'OpenRouter' },
    ]);
  });

  it('should return a copy (not a reference to internal state)', () => {
    const providers1 = getProviders();
    const providers2 = getProviders();

    expect(providers1).not.toBe(providers2);
    expect(providers1).toEqual(providers2);
  });
});

describe('getApiKey', () => {
  it('should return undefined when no key is available', () => {
    expect(getApiKey()).toBeUndefined();
    expect(getApiKey('anthropic')).toBeUndefined();
  });

  it('should return in-memory key over env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-key';
    updateSettings({ apiKeys: { anthropic: 'sk-mem-key' } });

    expect(getApiKey('anthropic')).toBe('sk-mem-key');
  });

  it('should fall back to env var when no in-memory key', () => {
    process.env.OPENAI_API_KEY = 'sk-env-openai';

    expect(getApiKey('openai')).toBe('sk-env-openai');
  });

  it('should use current provider when no provider arg given', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-default-provider';

    expect(getApiKey()).toBe('sk-default-provider');
  });

  it('should return undefined for unknown provider', () => {
    expect(getApiKey('unknown')).toBeUndefined();
  });
});

describe('resetSettings', () => {
  it('should clear in-memory keys and restore defaults', () => {
    updateSettings({
      provider: 'openai',
      model: 'gpt-4o',
      apiKeys: { openai: 'sk-test' },
    });

    resetSettings();

    const settings = getSettings();
    expect(settings.provider).toBe('anthropic');
    expect(settings.model).toBe('claude-3-5-haiku-latest');
    expect(getApiKey('openai')).toBeUndefined();
  });
});
