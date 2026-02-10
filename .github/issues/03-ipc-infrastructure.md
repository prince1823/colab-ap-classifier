## Summary

Set up the type-safe IPC communication layer between Electron main and renderer processes. This includes the preload script, contextBridge API exposure, and a handler registration framework.

## Scope

### Preload Script (`src/preload/index.ts`)
- Use `contextBridge.exposeInMainWorld` to expose a typed API
- Expose `window.api.invoke(channel, ...args)` for request/response
- Expose `window.api.on(channel, callback)` for events (main→renderer)
- Expose `window.api.removeListener(channel, callback)` for cleanup

### Handler Registration Framework (`src/main/ipc/`)
- `src/main/ipc/register.ts` — helper to register handlers with error wrapping
  - Auto-wraps handlers to return `IPCResponse<T>` (catch errors → `{ success: false, error: message }`)
  - Logs handler registration for debugging
- `src/main/ipc/index.ts` — master registration function that calls all namespace registrators
  - Will be filled in as services are built

### Type Safety
- IPC channel names should be typed constants (shared between main and renderer)
- Handler return types should match the IPC contract
- Consider a type-safe invoke helper on the renderer side

### Acceptance Criteria
- [ ] Preload script exposes `window.api` with invoke, on, removeListener
- [ ] Handler registration helper wraps errors into IPCResponse
- [ ] A test IPC channel (`test:ping` → `{ success: true, data: 'pong' }`) works end-to-end
- [ ] Event emission from main to renderer works
- [ ] TypeScript compilation clean

## Dependencies
- **S1-01** (Project Scaffolding) — Electron app must exist
- **S1-02** (Shared Types) — IPCResponse type

## Spec References
- `internal_docs/ipc_contract.md` — response envelope, channel naming
- `CLAUDE.md` — IPC conventions section
