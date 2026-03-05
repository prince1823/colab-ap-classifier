# PR 4: ClassificationTree Split — Break Up 1,205-Line Component

## Problem
`ClassificationTree.tsx` (1,205 lines) mixes taxonomy tree rendering, drag-drop
for reclassification, and keyboard shortcuts in one file.

## Core Type Rules (apply everywhere in this PR)

- No `React.Dispatch<SetStateAction<X>>` in hook return types or component props.
  All callbacks that set state use: `(updater: ((prev: X) => X) | X) => void`
- No `any` for drag items, tree nodes, or row data.
- `DashboardTransactionRow` (from `src/renderer/utils/transactionTransform.ts`) is the
  row type for any transactions passed to the tree — not `any[]`, not `Record<string, unknown>[]`.
- `humanReviewed` is a `boolean` on `DashboardTransactionRow`. Do NOT check
  `classification_status === 'human_reviewed'` — that value does not exist in the union.

---

## Changes

### 1. Define typed drag items

The tree has two drag directions:
- **From tree node → table row** (apply classification filter)
- **From table row → tree node** (reclassify transaction)

Define these as a discriminated union in `src/renderer/types/dragItems.ts`:

```typescript
export type DragItem =
  | { type: 'tree-node'; path: string; label: string }
  | { type: 'transaction-row'; transactionId: string; currentPath: string }
```

All drag handlers receive `DragItem`, not `any` or `unknown`.

### 2. Extract drag-drop logic: `useTreeDragDrop.ts`

```typescript
import type { DragItem } from '../../types/dragItems'

interface UseTreeDragDropOptions {
  onReclassify: (transactionId: string, newPath: string) => void
}

function useTreeDragDrop(options: UseTreeDragDropOptions): {
  dragItem: DragItem | null
  isDragging: boolean
  getNodeDropProps: (nodePath: string) => {
    onDragOver: React.DragEventHandler
    onDrop: React.DragEventHandler
  }
  getRowDragProps: (transactionId: string, currentPath: string) => {
    draggable: true
    onDragStart: React.DragEventHandler
  }
}
```

- Manages `dragItem: DragItem | null` state internally
- `getNodeDropProps` — returns handlers for tree node drop zones
- `getRowDragProps` — returns handlers for draggable transaction rows
- Calls `options.onReclassify` when a row is dropped on a node
- No `any` in drag event data — use `DragItem` serialized through `dataTransfer.setData` / `JSON.parse`

### 3. Extract keyboard shortcuts: `useTreeKeyboard.ts`

```typescript
interface UseTreeKeyboardOptions {
  expandedNodes: Set<string>
  setExpandedNodes: (updater: ((prev: Set<string>) => Set<string>) | Set<string>) => void
  focusedPath: string | null
  setFocusedPath: (path: string | null) => void
  onReclassify: (transactionId: string, newPath: string) => void
  selectedRows: string[]  // transaction IDs
}

function useTreeKeyboard(options: UseTreeKeyboardOptions): {
  handleKeyDown: React.KeyboardEventHandler
}
```

- Arrow keys: navigate tree nodes
- Enter: expand/collapse focused node
- Keyboard-driven reclassification when a row is focused
- `setExpandedNodes` and `setFocusedPath` use the functional updater pattern, not `Dispatch`

### 4. Extract tree data building into `taxonomyLoader.ts`

Move path parsing, parent-child linking, and node count computation to
`src/renderer/utils/taxonomyLoader.ts`. Define typed return types:

```typescript
export interface TaxonomyNode {
  path: string
  label: string
  level: number
  children: TaxonomyNode[]
  transactionCount: number
  parentPath: string | null
}

export function buildTaxonomyTree(
  paths: string[],
  transactionCountByPath: Record<string, number>
): TaxonomyNode[]
```

- `paths` are pipe-delimited strings: `"Corporate Services|IT|Software"`
- `transactionCountByPath` maps full path to count (fetched via IPC)
- No `any` in the tree structure

### 5. Simplify ClassificationTree to rendering only

After extraction, `ClassificationTree` receives:

```typescript
interface ClassificationTreeProps {
  nodes: TaxonomyNode[]
  expandedNodes: Set<string>
  setExpandedNodes: (updater: ((prev: Set<string>) => Set<string>) | Set<string>) => void
  focusedPath: string | null
  setFocusedPath: (path: string | null) => void
  onReclassify: (transactionId: string, newPath: string) => void
  selectedRows: string[]
  keyboardFocus: 'tree' | 'tables'
}
```

- Renders `TaxonomyNode[]` recursively
- Delegates drag events to `useTreeDragDrop`
- Delegates keyboard to `useTreeKeyboard`
- ~300-400 lines

### 6. Dashboard wires it together

Dashboard calls `useReclassification()` and `useUndoRedo()` (per PR 3).
The `onReclassify` callback is passed from Dashboard → ClassificationTree.
Dashboard owns the `selectedRows` string from `ReviewFilterContext`.

---

## Type Checklist for New Files
Before opening the PR, verify:
- [ ] No `React.Dispatch<SetStateAction<X>>` in hook interfaces or component props
- [ ] No `any` for drag items — use `DragItem` discriminated union
- [ ] `DashboardTransactionRow` used for transaction data, not `any[]`
- [ ] No `classification_status === 'human_reviewed'` — use `row.humanReviewed` boolean
- [ ] `tsc --noEmit` passes with zero errors (no `as any` workarounds)

## Dependencies
- PR 3 (Dashboard Decomposition) — Dashboard wires `onReclassify` from `useReclassification()`
- Independent of PRs 1-2 (tree doesn't own filter state)

## Files touched
- `src/renderer/components/review/ClassificationTree.tsx` (major refactor)
- New: `src/renderer/types/dragItems.ts`
- New: `src/renderer/hooks/useTreeDragDrop.ts`
- New: `src/renderer/hooks/useTreeKeyboard.ts`
- `src/renderer/utils/taxonomyLoader.ts` (extend with `buildTaxonomyTree`)
