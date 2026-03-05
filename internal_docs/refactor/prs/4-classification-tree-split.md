# PR 4: ClassificationTree Split — Break Up 1,205-Line Component

## Problem
`ClassificationTree.tsx` (1,205 lines) mixes taxonomy tree rendering, drag-drop
for reclassification, and keyboard shortcuts in one file.

## Changes

### 1. Extract drag-drop logic
- `useTreeDragDrop.ts` — manages drag state, drop zones on tree nodes,
  reclassification via drop
- Reuses reclassification action from `useReclassification` hook

### 2. Extract keyboard shortcuts
- `useTreeKeyboard.ts` — arrow key navigation, enter to expand/collapse,
  keyboard-driven reclassification
- Or extend existing `useKeyboardShortcuts.ts` with tree-specific bindings

### 3. Extract tree data building
- Move taxonomy tree structure building (path parsing, parent-child linking,
  node count computation) into `src/renderer/utils/taxonomyLoader.ts`
  (may already partially exist — extend it)

### 4. Simplify ClassificationTree to rendering only
- Receives tree data, renders nodes recursively
- Delegates drag-drop to hook
- Delegates keyboard to hook
- ~300-400 lines

## Dependencies
- Independent of PRs 1-3

## Files touched
- `src/renderer/components/review/ClassificationTree.tsx` (major refactor)
- New: `src/renderer/hooks/useTreeDragDrop.ts`
- New: `src/renderer/hooks/useTreeKeyboard.ts` (or extend existing)
- `src/renderer/utils/taxonomyLoader.ts` (extend)
