import { registerHandler } from './register';
import type { ILLMConfig } from '../../shared/types/services';
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

export function registerSettingsHandlers(appConfig: ILLMConfig): void {
  registerHandler('settings:getLLMConfig', async (): Promise<LLMConfigResponse> => {
    return {
      provider: appConfig.getProvider(),
      model: appConfig.getModel(),
      hasOpenRouterKey: appConfig.getApiKey('openrouter') !== null,
      hasAnthropicKey:  appConfig.getApiKey('anthropic') !== null,
      hasOpenAIKey:     appConfig.getApiKey('openai') !== null,
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
}
