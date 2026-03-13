# PR 7: LLM API Key UI — Allow Setting Keys From the App

## Problem
LLM API keys are currently read from `.env` / `process.env` at startup only.
The `SettingsDialog` (`src/renderer/components/SettingsDialog.tsx`) is read-only —
it displays provider/model info and tells users to edit `.env` directly.
The `OpenRouterLLMClient` reads keys via `getApiKeyForProvider()` from `process.env`
on each `chat()` call. There is no way to set or change keys at runtime.

## Core Type Rules (apply everywhere in this PR)

- No `any` in `SettingsDialog` form state — use a typed interface for form values.
- IPC response shapes must be defined in `src/shared/types/ipc-contract.ts` first,
  then used in both main and renderer — never use `any` for response shapes.
- Form event handlers must be typed: `React.ChangeEvent<HTMLInputElement>`,
  not `any` or inferred-`any` from untyped event.
- State setters in `SettingsDialog` use plain `useState` — no `Dispatch<SetStateAction>`
  in props (this is a leaf component, it doesn't pass state setters to children).

---

## Current key flow
1. `src/main/load-env.ts` reads `.env` at startup, populates `process.env`
2. `src/main/services/llm-client.ts` — `getApiKeyForProvider()` reads `process.env.OPENROUTER_API_KEY`, etc.
3. `OpenRouterLLMClient` is instantiated once in the DI container
4. Env vars: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
5. Provider/model: `CLASSIFIER_LLM_PROVIDER` (default `openrouter`), `CLASSIFIER_MODEL` (default `claude-3-5-haiku-latest`)

---

## Changes

### 1. Define typed IPC shapes first (in `ipc-contract.ts`)

Add to `src/shared/types/ipc-contract.ts` before writing any implementation:

```typescript
export interface LLMConfigResponse {
  provider: string
  model: string
  hasOpenRouterKey: boolean
  hasAnthropicKey: boolean
  hasOpenAIKey: boolean
}

// Add to IPCInvokeMap
'settings:getLLMConfig': { args: []; response: LLMConfigResponse }
'settings:setApiKey': { args: [provider: string, key: string]; response: void }
'settings:setProvider': { args: [provider: string]; response: void }
'settings:setModel': { args: [model: string]; response: void }
'settings:validateApiKey': { args: [provider: string, key: string]; response: { valid: boolean; error?: string } }
```

**Rule:** The renderer must ONLY receive `LLMConfigResponse` (boolean flags) — never the actual
key values. Actual keys never leave the main process.

### 2. Create LLMConfigService

New service in `src/main/services/llm-config.ts`. Add its interface to `src/shared/types/services.ts`:

```typescript
export interface ILLMConfigService {
  getApiKey(provider: string): string | null
  setApiKey(provider: string, key: string): Promise<void>
  getProvider(): string
  setProvider(provider: string): Promise<void>
  getModel(): string
  setModel(model: string): Promise<void>
}
```

- Storage: app-level config file at `~/.config/Colab91 Classifier/llm-config.json`
  (or use Electron `safeStorage` to encrypt keys at rest)
- Fallback chain: config file key > env var > `.env` file
- No `any` in JSON parsing — validate shape before trusting config file contents

### 3. Update OpenRouterLLMClient to use LLMConfigService

- Constructor receives `ILLMConfigService` instead of reading `process.env` directly
- `getApiKeyForProvider()` queries the config service
- No app restart needed — config service reads latest values on each call

### 4. Add IPC handlers

New file `src/main/ipc/settings.ts`:
```typescript
export function registerSettingsHandlers(
  ipc: IpcMain,
  llmConfig: ILLMConfigService
): void { ... }
```

All handler function signatures are typed against `IPCInvokeMap` — no `as any` for args.

### 5. Update SettingsDialog with typed form state

```typescript
interface SettingsFormState {
  provider: string
  model: string
  apiKey: string
  isValidating: boolean
  validationResult: { valid: boolean; error?: string } | null
}
```

In `SettingsDialog.tsx`:
- `const [form, setForm] = useState<SettingsFormState>({ ... })` — fully typed
- Form event handlers: `(e: React.ChangeEvent<HTMLInputElement>) => void` — no `any`
- IPC calls use `LLMConfigResponse` return type, not `any`
- Show green checkmark if key is already set (via `hasXxxKey` booleans from IPC)
- Key validation on save (call `settings:validateApiKey` before persisting)
- Success/error toast feedback
- The Sidebar already has a gear icon wired to this dialog

### 6. Wire into DI container

- Add `LLMConfigService` to `createContainer()` in `src/main/container.ts`
- Pass to `OpenRouterLLMClient` constructor
- Pass to `registerSettingsHandlers()`

---

### Security considerations
- Keys never sent to renderer — only "is set" booleans (`LLMConfigResponse`)
- Keys stored encrypted via Electron `safeStorage` (preferred) or in a config file
  in the user's config directory (acceptable for desktop app)
- All LLM calls stay in the main process

---

## Type Checklist
Before opening the PR, verify:
- [ ] `LLMConfigResponse` defined in `ipc-contract.ts` before writing any handler or UI code
- [ ] `SettingsFormState` interface with no `any` fields
- [ ] All form handlers typed as `React.ChangeEvent<HTMLInputElement>` — not `any`
- [ ] No actual API key values sent to renderer — only boolean flags
- [ ] `tsc --noEmit` passes with zero errors

## Dependencies
- Independent (can be done anytime, but pairs well with PR 0 since classification
  failures are often caused by missing API keys)

## Files touched
- `src/shared/types/ipc-contract.ts` (new channels + `LLMConfigResponse` type)
- `src/shared/types/services.ts` (`ILLMConfigService` interface)
- New: `src/main/services/llm-config.ts` (LLMConfigService)
- `src/main/services/llm-client.ts` (use config service instead of process.env)
- `src/main/container.ts` (wire LLMConfigService)
- New: `src/main/ipc/settings.ts` (register settings handlers)
- `src/main/ipc/index.ts` (register new handler file)
- `src/renderer/components/SettingsDialog.tsx` (typed form state, editable form)
