## Summary

Implement the Recent Projects service that tracks recently opened projects in a JSON file stored in the user's config directory.

## Scope

### Service (`src/main/services/recent-projects.ts`)

**Storage:** `~/.config/Colab91 Classifier/recent-projects.json`

**Data Structure:**
```typescript
interface RecentProject {
  path: string;
  name: string;
  lastOpened: string; // ISO timestamp
}
```

**Operations:**
- `listRecent(): Promise<RecentProject[]>` — return all recent projects, sorted by lastOpened desc
- `addRecent(path: string, name: string): Promise<void>` — add or update entry (move to top)
- `removeRecent(filePath: string): Promise<void>` — remove entry by path
- `clearRecent(): Promise<void>` — remove all entries
- Handle missing/corrupt JSON file gracefully (return empty array)
- Limit to last 20 projects

### IPC Handlers (`src/main/ipc/recent-projects.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `recentProjects:list` | none | `RecentProject[]` |
| `recentProjects:clear` | none | `void` |
| `recentProjects:remove` | `filePath: string` | `void` |

### Integration with Project Service
- When a project is opened or created (in S1-05), call `addRecent()`
- This wiring happens in the project service (already a dependency)

### Tests
- Add project → list returns it
- Add same project twice → updates lastOpened, no duplicate
- Remove project → gone from list
- Clear → empty list
- Corrupt JSON file → returns empty array gracefully
- Max 20 entries enforced

### Acceptance Criteria
- [ ] JSON file created in correct config directory
- [ ] All 3 IPC handlers registered and functional
- [ ] List sorted by most recently opened first
- [ ] Handles missing/corrupt config file gracefully
- [ ] Unit tests pass

## Dependencies
- **S1-03** (IPC Infrastructure) — handler registration
- **S1-05** (Project Service) — calls addRecent on open/create

## Spec References
- `internal_docs/ipc_contract.md` — Recent Projects section (channels 9-11)
- `CLAUDE.md` — recent projects tracked in `~/.config/Colab91 Classifier/recent-projects.json`
