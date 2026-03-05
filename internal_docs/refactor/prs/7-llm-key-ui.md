# PR 7: LLM API Key UI — Allow Setting Keys From the App

## Problem
LLM API keys are currently read from `.env` / `process.env` at startup only.
The `SettingsDialog` (`src/renderer/components/SettingsDialog.tsx`) is read-only —
it displays provider/model info and tells users to edit `.env` directly.
The `OpenRouterLLMClient` reads keys via `getApiKeyForProvider()` from `process.env`
on each `chat()` call. There is no way to set or change keys at runtime.

## Current key flow
1. `src/main/load-env.ts` reads `.env` at startup, populates `process.env`
2. `src/main/services/llm-client.ts` — `getApiKeyForProvider()` reads `process.env.OPENROUTER_API_KEY`, etc.
3. `OpenRouterLLMClient` is instantiated once in the DI container
4. Env vars: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
5. Provider/model: `CLASSIFIER_LLM_PROVIDER` (default `openrouter`), `CLASSIFIER_MODEL` (default `claude-3-5-haiku-latest`)

## Changes

### 1. Create LLMConfigService
- New service that wraps mutable LLM configuration (keys, provider, model)
- Storage: app-level config file at `~/.config/Colab91 Classifier/llm-config.json`
  (or use Electron `safeStorage` to encrypt keys at rest)
- Fallback chain: config file key > env var > `.env` file
- Methods: `getApiKey(provider)`, `setApiKey(provider, key)`, `getProvider()`, `setProvider()`, `getModel()`, `setModel()`

### 2. Update OpenRouterLLMClient to use LLMConfigService
- Constructor receives `LLMConfigService` instead of reading `process.env` directly
- `getApiKeyForProvider()` queries the config service
- No app restart needed — config service reads latest values on each call

### 3. Add IPC channels for LLM settings
New channels in `src/main/ipc/settings.ts`:
- `settings:getLLMConfig` → returns `{ provider, model, hasOpenRouterKey, hasAnthropicKey, hasOpenAIKey }` (booleans only, never send actual keys to renderer)
- `settings:setApiKey(provider, key)` → saves key, returns success
- `settings:setProvider(provider)` → saves provider preference
- `settings:setModel(model)` → saves model preference
- `settings:validateApiKey(provider, key)` → makes a lightweight API call to verify the key works

### 4. Update SettingsDialog from read-only to editable
- `src/renderer/components/SettingsDialog.tsx` — currently shows static text
- Replace with: provider dropdown, model input, API key input (masked), save button
- Show green checkmark if key is already set (via `hasXxxKey` booleans from IPC)
- Key validation on save (call `settings:validateApiKey` before persisting)
- Success/error toast feedback
- The Sidebar already has a gear icon wired to this dialog

### 5. Wire into DI container
- Add `LLMConfigService` to `createContainer()` in `src/main/container.ts`
- Pass to `OpenRouterLLMClient` constructor
- Pass to `registerSettingsHandlers()`

### Security considerations
- Keys never sent to renderer — only "is set" booleans
- Keys stored encrypted via Electron `safeStorage` (preferred) or in a config file
  in the user's config directory (acceptable for desktop app)
- All LLM calls stay in the main process

## Dependencies
- Independent (can be done anytime, but pairs well with PR 0 since classification
  failures are often caused by missing API keys)

## Files touched
- New: `src/main/services/llm-config.ts` (LLMConfigService)
- `src/main/services/llm-client.ts` (use config service instead of process.env)
- `src/main/container.ts` (wire LLMConfigService)
- New: `src/main/ipc/settings.ts` (register settings handlers)
- `src/main/ipc/index.ts` (register new handler file)
- `src/renderer/components/SettingsDialog.tsx` (editable form)
- `src/shared/types/ipc-contract.ts` (new channels)
- `src/shared/types/services.ts` (LLMConfigService interface)
