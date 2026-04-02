import { registerHandler } from './register';
import type { IAppConfigService, ILLMConfig } from '../../shared/types/services';
import type { LLMConfigResponse } from '../../shared/types/ipc-contract';

async function validateApiKey(
  provider: string,
  key: string
): Promise<{ valid: boolean; error?: string }> {
  type EndpointDef = { url: string; headers: Record<string, string> };
  const endpoints: Record<string, EndpointDef> = {
    openrouter: {
      url: 'https://openrouter.ai/api/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    },
    anthropic: {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    },
    openai: {
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    },
  };

  const endpoint = endpoints[provider];
  if (!endpoint) return { valid: false, error: `Unknown provider: ${provider}` };

  try {
    const response = await fetch(endpoint.url, { headers: endpoint.headers });
    if (response.ok) return { valid: true };
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    return { valid: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function validateExaKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', numResults: 1 }),
    });
    if (response.ok) return { valid: true };
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    return { valid: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function validateModel(
  provider: string,
  key: string,
  model: string
): Promise<{ valid: boolean; error?: string }> {
  type EndpointDef = { url: string; headers: Record<string, string> };
  const endpoints: Record<string, EndpointDef> = {
    openrouter: {
      url: 'https://openrouter.ai/api/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    },
    anthropic: {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    },
    openai: {
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    },
  };

  const endpoint = endpoints[provider];
  if (!endpoint) return { valid: false, error: `Unknown provider: ${provider}` };

  try {
    const response = await fetch(endpoint.url, { headers: endpoint.headers });
    if (!response.ok) {
      return { valid: false, error: `Could not fetch models (HTTP ${response.status})` };
    }
    const body = await response.json() as { data?: Array<{ id: string }> };
    const models = body.data ?? [];
    const found = models.some((m) => m.id === model);
    if (found) return { valid: true };
    return { valid: false, error: `Model "${model}" not found for ${provider}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerSettingsHandlers(appConfig: ILLMConfig & Pick<IAppConfigService, 'getExaApiKey' | 'setExaApiKey'>): void {
  registerHandler('settings:getLLMConfig', async (): Promise<LLMConfigResponse> => {
    return {
      provider: appConfig.getProvider(),
      model: appConfig.getModel(),
      hasOpenRouterKey: appConfig.getApiKey('openrouter') !== null,
      hasAnthropicKey:  appConfig.getApiKey('anthropic') !== null,
      hasOpenAIKey:     appConfig.getApiKey('openai') !== null,
      hasExaKey:        appConfig.getExaApiKey() !== null,
    };
  });

  registerHandler('settings:setApiKey', async (_event, provider: unknown, key: unknown) => {
    await appConfig.setApiKey(provider as string, key as string);
  });

  registerHandler('settings:setProvider', async (_event, provider: unknown) => {
    await appConfig.setProvider(provider as string);
  });

  registerHandler('settings:setModel', async (_event, model: unknown) => {
    await appConfig.setModel(model as string);
  });

  registerHandler('settings:validateApiKey', async (_event, provider: unknown, key: unknown) => {
    return validateApiKey(provider as string, key as string);
  });

  registerHandler('settings:setExaKey', async (_event, key: unknown) => {
    await appConfig.setExaApiKey(key as string);
  });

  registerHandler('settings:validateExaKey', async (_event, key: unknown) => {
    return validateExaKey(key as string);
  });

  registerHandler('settings:validateStoredExaKey', async () => {
    const key = appConfig.getExaApiKey();
    if (!key) return { valid: false, error: 'No Exa API key stored' };
    return validateExaKey(key);
  });

  registerHandler('settings:validateStoredApiKey', async (_event, provider: unknown) => {
    const key = appConfig.getApiKey(provider as string);
    if (!key) return { valid: false, error: `No API key stored for ${provider as string}` };
    return validateApiKey(provider as string, key);
  });

  registerHandler('settings:validateModel', async (_event, provider: unknown, key: unknown, model: unknown) => {
    return validateModel(provider as string, key as string, model as string);
  });

  registerHandler('settings:validateStoredModel', async (_event, provider: unknown, model: unknown) => {
    const key = appConfig.getApiKey(provider as string);
    if (!key) return { valid: false, error: `No API key stored for ${provider as string}` };
    return validateModel(provider as string, key, model as string);
  });
}
