## Summary

Implement the Settings service for LLM provider configuration — managing API keys, provider selection, and model listing.

## Scope

### Service (`src/main/services/settings.ts`)

**LLM Provider Config:**
- Read from environment variables: `CLASSIFIER_LLM_PROVIDER`, `CLASSIFIER_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Allow runtime override via settings API
- Default provider: `anthropic`, default model: `claude-3-5-haiku-latest`

**Operations:**
- `getSettings(): AppSettings` — return current provider, model, hasApiKey, availableProviders
- `updateSettings(input: SettingsUpdateInput): void` — update provider, model, or API keys
- `getModels(): ModelInfo[]` — return supported models for current provider
- `getProviders(): ProviderInfo[]` — return available providers

**Supported Providers & Models:**
```
anthropic:
  - claude-3-5-haiku-latest
  - claude-sonnet-4-20250514
  - claude-opus-4-20250514
openai:
  - gpt-4o
  - gpt-4o-mini
  - gpt-4-turbo
openrouter:
  - Routes to any of the above with single key
```

**API Key Storage:**
- In-memory during session (not persisted to disk for security)
- Environment variables used as fallback
- `hasApiKey` returns true if a key is available for current provider

### IPC Handlers (`src/main/ipc/settings.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `settings:get` | none | `AppSettings` |
| `settings:update` | `SettingsUpdateInput` | `void` |
| `settings:getModels` | none | `ModelInfo[]` |
| `settings:getProviders` | none | `ProviderInfo[]` |

### Tests
- Default settings from env vars
- Update provider and model
- API key availability check
- Model list per provider

### Acceptance Criteria
- [ ] All 4 IPC handlers registered and functional
- [ ] Reads from env vars as defaults
- [ ] Provider/model switching works
- [ ] API key masking (hasApiKey boolean, never returns raw key)
- [ ] Unit tests pass

## Dependencies
- **S1-03** (IPC Infrastructure) — handler registration

## Spec References
- `internal_docs/ipc_contract.md` — Settings section (channels 46-49)
- `internal_docs/backend_spec.md` — LLM configuration
