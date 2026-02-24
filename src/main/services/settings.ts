import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type {
  AppSettings,
  SettingsUpdateInput,
  ModelInfo,
  ProviderInfo,
} from '../../shared/types/settings';

/**
 * Supported models per provider.
 */
const PROVIDER_MODELS: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
  ],
  openrouter: [
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
  ],
};

/**
 * Available providers.
 */
const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'openrouter', name: 'OpenRouter' },
];

/**
 * Environment variable names for API keys, keyed by provider id.
 */
const API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-3-5-haiku-latest';

// Runtime state
let currentProvider: string =
  process.env.CLASSIFIER_LLM_PROVIDER || DEFAULT_PROVIDER;
let currentModel: string = process.env.CLASSIFIER_MODEL || DEFAULT_MODEL;
const apiKeys: Map<string, string> = new Map();

// Persistence
const SETTINGS_FILE = 'app-settings.json';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

interface PersistedSettings {
  provider?: string;
  model?: string;
  apiKeys?: Record<string, string>;
}

function loadPersistedSettings(): void {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) return;
    const data: PersistedSettings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    if (data.provider && PROVIDERS.some((p) => p.id === data.provider)) {
      currentProvider = data.provider;
    }
    if (data.model) {
      currentModel = data.model;
    }
    if (data.apiKeys) {
      for (const [provider, key] of Object.entries(data.apiKeys)) {
        if (typeof key === 'string' && key.length > 0) {
          apiKeys.set(provider, key);
        }
      }
    }
  } catch {
    // Ignore corrupt file
  }
}

function persistSettings(): void {
  try {
    const data: PersistedSettings = {
      provider: currentProvider,
      model: currentModel,
      apiKeys: Object.fromEntries(apiKeys.entries()),
    };
    const dir = path.dirname(getSettingsPath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — don't crash if write fails
  }
}

// Load persisted settings at module init (after env vars have been applied)
loadPersistedSettings();

/**
 * Get the current application settings.
 */
export function getSettings(): AppSettings {
  return {
    provider: currentProvider,
    model: currentModel,
    hasApiKey: getApiKey(currentProvider) !== undefined,
    availableProviders: PROVIDERS.map((p) => p.id),
  };
}

/**
 * Update provider, model, or API keys at runtime.
 */
export function updateSettings(input: SettingsUpdateInput): void {
  if (input.provider !== undefined) {
    if (!PROVIDERS.some((p) => p.id === input.provider)) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
    currentProvider = input.provider;
  }

  if (input.model !== undefined) {
    currentModel = input.model;
  }

  if (input.apiKeys) {
    for (const [provider, key] of Object.entries(input.apiKeys)) {
      apiKeys.set(provider, key);
    }
  }

  persistSettings();
}

/**
 * Return supported models for a given provider (defaults to current provider).
 */
export function getModels(provider?: string): ModelInfo[] {
  const target = provider || currentProvider;
  return PROVIDER_MODELS[target] || [];
}

/**
 * Return available providers.
 */
export function getProviders(): ProviderInfo[] {
  return [...PROVIDERS];
}

/**
 * Return the API key for a provider (defaults to current provider).
 * Checks in-memory store first, then environment variables.
 * Internal use only — not exposed via IPC.
 */
export function getApiKey(provider?: string): string | undefined {
  const target = provider || currentProvider;

  // Check in-memory keys first
  const memoryKey = apiKeys.get(target);
  if (memoryKey) {
    return memoryKey;
  }

  // Fall back to environment variables
  const envVar = API_KEY_ENV_VARS[target];
  if (envVar) {
    const envValue = process.env[envVar];
    if (envValue) {
      return envValue;
    }
  }

  return undefined;
}

/**
 * Reset all runtime state to defaults (useful for testing).
 */
export function resetSettings(): void {
  currentProvider = process.env.CLASSIFIER_LLM_PROVIDER || DEFAULT_PROVIDER;
  currentModel = process.env.CLASSIFIER_MODEL || DEFAULT_MODEL;
  apiKeys.clear();
}
