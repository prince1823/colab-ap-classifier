## Summary

Initialize the Electron + React + TypeScript project with build tooling, directory structure, and test framework. This is the foundation every other issue builds on.

## Scope

### Directory Structure
```
colab-ap-classifier/
├── package.json
├── tsconfig.json
├── tsconfig.main.json        # Main process TS config
├── tsconfig.renderer.json    # Renderer TS config
├── electron-builder.yml      # Electron packaging config
├── vite.config.ts            # Vite for renderer
├── vitest.config.ts          # Test config
├── src/
│   ├── main/
│   │   ├── index.ts          # Electron main entry
│   │   ├── ipc/              # IPC handler registrations (empty)
│   │   ├── services/         # Backend services (empty)
│   │   └── agents/           # LLM agents (empty)
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx          # React entry
│   │   ├── App.tsx           # Root component (placeholder)
│   │   ├── components/
│   │   ├── pages/
│   │   └── hooks/
│   ├── shared/
│   │   └── types/            # Shared TS interfaces (empty, filled in #2)
│   └── preload/
│       └── index.ts          # Preload stub
├── tests/
│   ├── unit/
│   ├── integration/
│   └── helpers/
```

### Dependencies to Install
- **Electron** (latest stable)
- **React 18** + react-dom
- **TypeScript 5.x**
- **Vite** + @vitejs/plugin-react (renderer bundler)
- **electron-builder** (packaging)
- **vitest** (testing) + @testing-library/react
- **duckdb** (Node.js binding — `duckdb-async` or `@duckdb/node-bindings`)
- **csv-parse** (CSV parsing)
- **uuid** (ID generation)
- **electron-store** or fs-based config (for recent projects JSON)

### Acceptance Criteria
- [ ] `npm install` succeeds
- [ ] `npm run dev` launches an Electron window showing a React "Hello World"
- [ ] `npm run build` produces a distributable
- [ ] `npm run test` runs vitest and passes with a placeholder test
- [ ] TypeScript compilation has zero errors
- [ ] Main process and renderer process have separate tsconfig files
- [ ] Directory structure matches the spec in CLAUDE.md

## Dependencies
None — this is the first issue.

## Spec References
- `CLAUDE.md` — Project Structure section
- `internal_docs/backend_spec.md` — Tech stack
