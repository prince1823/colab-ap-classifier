export interface ModelInfo {
  id: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
}

export interface AppSettings {
  provider: string;
  model: string;
  hasApiKey: boolean;
  availableProviders: string[];
}

export interface SettingsUpdateInput {
  provider?: string;
  model?: string;
  apiKeys?: Record<string, string>;
}
