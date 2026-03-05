# PR 4: ClassificationTree Split — Break Up 1,205-Line Component

## Problem

`ClassificationTree.tsx` (1,205 lines) mixes taxonomy tree rendering, drag-drop
for reclassification, keyboard shortcuts, and CRUD modals in one file. It also
does client-side filtering of transactions — wrong per architecture.

## Core Type Rules (apply everywhere in this PR)

- No `React.Dispatch<SetStateAction<X>>` in hook return types or component props.
  Use plain updater callbacks: `(updater: ((prev: X) => X) | X) => void`
- No `Record<string, unknown>[]` blobs for transaction data — use IDs (`string[]`)
- `DashboardTransactionRow` (from `src/renderer/utils/transactionTransform.ts`) is
  the row type — not `any[]`, not `Record<string, unknown>[]`
- No client-side filtering of transactions in ClassificationTree — `activeFilters`
  prop is removed entirely. The tree receives pre-loaded paths and server-side counts.

---

## Changes

### 1. Define shared drag item type (`src/renderer/types/dragItems.ts`)

The `DropItem` interface inside `ClassificationTree` and the `DragItem` inside
`MultiTableSystem` are local duplicates with loose typing. Extract a shared type:

```typescript
// Matches what MultiTableSystem emits as react-dnd drag payload
export interface DragItem {
  type: string                    // TABLE_ROW_TYPE | ITEM_TYPE
  column: string
  value: string
  selectedValues: string[]
  transactionRows: Record<string, unknown>[]  // kept for compat; IDs extracted server-side
  serverSide: boolean
  isSelected: boolean
  isMultiSelect: boolean
}
```

ClassificationTree's `ColumnNode` imports `DragItem` from here instead of the
local `DropItem`. `MultiTableSystem` can import and re-use this type for its local
`DragItem` (the two are currently duplicates).

### 2. Extract drag-drop hook: `useTreeDragDrop.ts`

Move the `useDrop` call and ID-resolution logic out of `ColumnNode` into a hook:

```typescript
import { useDrop } from 'react-dnd'
import type { DragItem } from '../../types/dragItems'
import { TABLE_ROW_TYPE, ITEM_TYPE } from '../components/review/MultiTableSystem'

interface UseNodeDropOptions {
  nodePath: string
  isDroppableLevel: boolean
  onDropIds: (transactionIds: string[], targetPath: string) => void
}

function useNodeDrop(options: UseNodeDropOptions): {
  dropRef: React.RefObject<HTMLDivElement | null>
  isOverShallow: boolean
  canDrop: boolean
}
```

- Wraps the `useDrop({ accept: [TABLE_ROW_TYPE, ITEM_TYPE], drop, collect })` call
- When `item.serverSide`, fetches IDs via `ipc.transactions.getIdsByValue` (as now)
- Resolves to `string[]` of transaction IDs before calling `onDropIds`
- Returns `dropRef` to attach to the node DOM element

`ColumnNode` calls `useNodeDrop` instead of `useDrop` directly.

### 3. Extract keyboard navigation: `useTreeKeyboard.ts`

Move `handleKeyboardNavigation`, `handleReclassifyWithKeyboard`, and the
`useKeyboardShortcuts` registration out of ClassificationTree:

```typescript
interface UseTreeKeyboardOptions {
  columns: TaxonomyTreeNode[][]
  keyboardNav: { columnIndex: number; nodeIndex: number }
  setKeyboardNav: (updater: ((prev: { columnIndex: number; nodeIndex: number }) => { columnIndex: number; nodeIndex: number }) | { columnIndex: number; nodeIndex: number }) => void
  selectedPath: string | null
  setSelectedPath: (path: string | null) => void
  setPathAtLevel: (path: string, level: number) => void
  setDrillSelection: (updater: ((prev: string[]) => string[]) | string[]) => void
  keyboardFocus: 'tree' | 'tables'
  setKeyboardFocus: (focus: 'tree' | 'tables') => void
  onReclassifyWithKeyboard: () => void
}

function useTreeKeyboard(options: UseTreeKeyboardOptions): void
// Registers keyboard shortcuts via useKeyboardShortcuts; no return value needed
```

`handleKeyboardNavigation` and `handleReclassifyWithKeyboard` move into the hook.
`ClassificationTree` passes `onReclassifyWithKeyboard` as a stable callback that
reads `keyboardNav` and `columns` from its own scope.

### 4. Fix ClassificationTree props

Remove props that enable client-side filtering or are unused:

```typescript
interface ClassificationTreeProps {
  // REMOVED: transactions — tree builds counts from groupedRows (see below)
  // REMOVED: activeFilters — no client-side filtering
  // REMOVED: mode, datasetId, foldername — unused
  groupedRows: GroupedRow[]          // classification_path rows from server (count + spend)
  selectedRows: string[]
  setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void  // plain callback, not Dispatch
  onReclassify: (transactionIds: string[], targetPath: string) => Promise<boolean>
  keyboardFocus: 'tree' | 'tables'
  setKeyboardFocus: (focus: 'tree' | 'tables') => void
}
```

`groupedRows` is `GroupedRow[]` (from `src/shared/types/transactions.ts`) for the
`classification_path` column — already fetched by `useGroupedTransactions` in
TablesTab. TablesTab adds `'classification_path'` to `groupedColumns` and passes
`groupedData.get('classification_path') ?? []` to ClassificationTree.

Tree counts are populated from `groupedRows` (server-aggregated, filter-aware):

```typescript
// In ClassificationTree useMemo:
const pathCounts = useMemo(() => {
  const map: Record<string, { count: number; amount: number }> = {}
  groupedRows.forEach(r => { map[r.value] = { count: r.count, amount: r.spend } })
  return map
}, [groupedRows])

const taxonomyTree = useMemo(() =>
  buildTaxonomyTree(taxonomyPaths, pathCounts),
  [taxonomyPaths, pathCounts]
)
```

### 5. Update `buildTaxonomyTree` in `taxonomyLoader.ts`

Add an overload that accepts pre-computed counts instead of raw transactions:

```typescript
// Existing signature kept for any other callers
export function buildTaxonomyTree(paths: string[]): TaxonomyTreeNode

// New signature used by ClassificationTree
export function buildTaxonomyTree(
  paths: string[],
  pathCounts: Record<string, { count: number; amount: number }>
): TaxonomyTreeNode
```

Or just update the single function to accept an optional second argument. No need
for `populateTreeWithTransactions` call when pathCounts is provided.

### 6. Fix reclassification chain

`onReclassify` receives `transactionIds: string[]` (resolved inside `useNodeDrop`
and `handleDropRow`), not `Record<string, unknown>[]`. Update Dashboard:

```typescript
// Dashboard.executeReclassification
async (transactionIds: string[], targetPath: string): Promise<boolean>
// No more rows.map(r => r.id as string) — IDs arrive directly
```

TablesTab passes the callback through without wrapping in rows:

```typescript
onReclassify={async (ids, targetPath) => executeReclassification(ids, targetPath)}
```

### 7. Result: ClassificationTree ~400 lines

After extraction, ClassificationTree contains:
- `taxonomyPaths` IPC load (`useEffect`)
- `taxonomyTree` + `pathMap` + `columns` + `drillSelection` useMemos
- `setPathAtLevel`, `handleDropRow`, `autoNavigateToPath`
- CRUD modal state + handlers (add/rename/delete — ~200 lines of JSX)
- `useNodeDrop` call in `ColumnNode`
- `useTreeKeyboard` call in main component
- Render JSX

---

## Type Checklist Before PR

- [ ] No `React.Dispatch<SetStateAction<X>>` in ClassificationTree or TablesTab props
- [ ] No `Record<string, unknown>[]` blobs passed through onReclassify chain
- [ ] `DragItem` imported from `src/renderer/types/dragItems.ts` in ClassificationTree
- [ ] `activeFilters` removed from ClassificationTree props entirely
- [ ] `groupedData.get('classification_path')` wired in TablesTab
- [ ] `tsc --noEmit` passes with zero errors

## Dependencies

- PR 3 (Dashboard Decomposition) — Dashboard owns `executeReclassification`
- `classification_path` must be a valid groupable column in `useGroupedTransactions`

## Files Touched

- `src/renderer/types/dragItems.ts` — new
- `src/renderer/hooks/useTreeDragDrop.ts` — new
- `src/renderer/hooks/useTreeKeyboard.ts` — new
- `src/renderer/utils/taxonomyLoader.ts` — extend `buildTaxonomyTree`
- `src/renderer/components/review/ClassificationTree.tsx` — major refactor
- `src/renderer/components/review/TablesTab.tsx` — add classification_path column, fix callback types
- `src/renderer/components/review/Dashboard.tsx` — fix executeReclassification signature
- `src/renderer/components/review/MultiTableSystem.tsx` — import DragItem from shared type (minor)
