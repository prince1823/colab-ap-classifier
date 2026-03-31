# Fix: Guard taxonomy node deletion when rules reference it

## Problem

When a taxonomy node is deleted, any `override_rules` rows with a matching `target_taxonomy_node_id` become orphaned. The classification runner looks up the node at apply-time and silently fails (no transaction gets classified) because the FK no longer resolves.

`taxonomy:deleteNode` currently only guards against transactions referencing the node — it does not check rules.

## Proposed fix

### 1. New `RuleStore` method

**`src/shared/types/services.ts`** — add to `RuleStore` interface:
```ts
getRulesForNode(targetTaxonomyNodeId: string): Promise<OverrideRule[]>;
```

**`src/main/services/rules.ts`** — implement:
```ts
async getRulesForNode(nodeId: string): Promise<OverrideRule[]> {
  const rows = await this.db.all<RuleRow>(
    'SELECT r.*, NULL AS group_priority FROM override_rules r WHERE r.target_taxonomy_node_id = ?',
    nodeId
  );
  return rows.map(rowToRule);
}
```

### 2. Update `registerTaxonomyHandlers`

**`src/main/ipc/taxonomy.ts`** — add `ruleStore: RuleStore` parameter.

**`src/main/ipc/index.ts`** — pass `services.rules` to `registerTaxonomyHandlers`.

### 3. Guard in `taxonomy:deleteNode` handler

```ts
registerHandler('taxonomy:deleteNode', async (_event, nodeId: unknown) => {
  const id = nodeId as string;
  const rules = await ruleStore.getRulesForNode(id);
  if (rules.length > 0) {
    const names = rules.slice(0, 3).map(r => `"${r.name}"`).join(', ');
    const more = rules.length > 3 ? ` and ${rules.length - 3} more` : '';
    throw new Error(
      `Cannot delete taxonomy node: ${rules.length} rule(s) reference it (${names}${more}). Remove or reassign those rules first.`
    );
  }
  await taxonomy.deleteNode(id);
});
```

## Notes

- Cat A rules are particularly impacted (silently break classification + leave stale universe paths) but the guard should apply to ALL rules, not just cat A.
- If a `reassignTo` path is ever exposed in the `taxonomy:deleteNode` IPC contract, consider also cascading rule `target_taxonomy_node_id` updates to point to the reassign target.
- Add to `tests/helpers/mock-services.ts`: `getRulesForNode: vi.fn().mockResolvedValue([])` on `createMockRuleStore`.
