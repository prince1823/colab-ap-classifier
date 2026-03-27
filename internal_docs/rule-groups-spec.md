# Rule Groups Spec

## Overview

Replace the current bucket system with **rule groups** — user-created, named collections of rules with an explicit priority ordering. Groups determine evaluation order; within a group, ordering is not required.

---

## Concepts

### Rule Group
A named container for rules with an integer priority. Higher priority number = evaluated first.

- User creates, renames, and deletes groups freely
- Each group has a `priority` integer — user-controlled, must be unique across all groups
- Rules are explicitly assigned to a group by the user (bulk assign via filtered selection)
- A rule belongs to at most one group
- Ungrouped rules exist and are always evaluated last, after all groups
- Ungrouped rules are not a group — there is no "Ungrouped" group entity in the DB

### Rule
Unchanged in structure — conditions, target taxonomy node, active flag, source. Loses its own `priorityScore`; ordering within a group is not needed.

---

## Evaluation Logic

### Current implementation (being replaced)

`evaluateRules()` in `rules.ts` currently:
1. Calls `listRules()` — `ORDER BY priority ASC, created_at DESC` — flat global priority across all rules
2. Loops through rules one at a time, calling `getIdsByGroupedConditions()` per rule — N DB queries for N rules
3. First-match-wins via `if (!matched.has(id))`

`bucket_id` on rules is currently **not used in evaluation** — buckets are purely visual and have no effect on which rule wins.

### New implementation

Replace the loop with a single JOIN query per transaction (or batched across transactions):

```sql
SELECT r.*
FROM override_rules r
LEFT JOIN rule_groups rg ON r.group_id = rg.id
WHERE r.is_active = TRUE
  AND <conditions match transaction>
ORDER BY COALESCE(rg.priority, 0) DESC, r.created_at DESC
LIMIT 1
```

- Group priorities must be `>= 1` (enforced in service), so `COALESCE(..., 0)` naturally places ungrouped rules below all named groups
- Within a group, if multiple rules match, latest `created_at` wins (deterministic tie-break, no user action required)

**Semantics:** highest-priority group that has any matching rule wins. If no named group matches, ungrouped rules are tried. If nothing matches, no rule applies.

### What transaction qualities are evaluated

Only the columns explicitly referenced in a rule's `groupedConditions` are checked against the transaction — nothing else. A rule with `supplier_name = "Acme"` only checks `supplier_name`. A rule with `supplier_name = "Acme"` AND `line_description = "scissors"` checks both. The system has no awareness of which rule is "more specific."

### Specificity is not considered

**Specificity plays no role in rule selection.** Given two rules that both match a transaction:

**Same group:** latest `created_at` wins. A rule with `supplier_name = "Acme" AND line_description = "scissors"` does NOT automatically beat a rule with just `supplier_name = "Acme"` — it only wins if it was created more recently.

**Different groups:** the rule in the higher-priority group always wins, regardless of how specific either rule is. The lower-priority group's rules are not evaluated once the higher group has a match.

**Implication for users:** if they want a more specific rule to always win, they must put it in a higher-priority group than the general rule.

---

## Data Model

### `rule_groups` table (replaces `rule_buckets`)

```sql
CREATE TABLE rule_groups (
  id         VARCHAR PRIMARY KEY,
  name       VARCHAR NOT NULL,
  priority   INTEGER NOT NULL UNIQUE CHECK (priority >= 1),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Dropped from `rule_buckets`: `sort_order`, `is_default`, `grouped_conditions`.

### `override_rules` changes

| Column | Change |
|--------|--------|
| `bucket_id` | Renamed to `group_id`, FK → `rule_groups.id`, nullable |
| `priority` / `priorityScore` | **Dropped** — no per-rule priority within group |

Rules with `group_id = NULL` are ungrouped.

---

## IPC Contract Changes

### Dropped
- `rules:reorderInBucket` — no within-group ordering

### Modified
| Channel | Change |
|---------|--------|
| `rules:listBuckets` → `rules:listGroups` | Returns `RuleGroup[]` sorted by `priority DESC` |
| `rules:createBucket` → `rules:createGroup` | Takes `{ name, priority }` — service rejects if priority < 1 or already taken |
| `rules:updateBucket` → `rules:updateGroup` | Can update `name` or `priority` — same uniqueness validation |
| `rules:deleteBucket` → `rules:deleteGroup` | Sets `group_id = NULL` on all rules in the group, then deletes group |
| `rules:reorderBuckets` → `rules:reorderGroups` | Takes `orderedIds[]`, reassigns sequential priority values (n, n-1, ...) |
| `rules:moveRule` | Simplified: `(ruleId, targetGroupId \| null)` — no position arg |

### New
| Channel | Args | Returns | Purpose |
|---------|------|---------|---------|
| `rules:assignToGroup` | `{ ruleIds: string[], groupId: string \| null }` | `void` | Bulk assign/ungroup rules |

---

## Shared Types

```typescript
interface RuleGroup {
  id: string;
  name: string;
  priority: number;       // >= 1; higher = evaluated first
  createdAt: string;
  ruleCount: number;      // included in listGroups response
}

interface RuleGroupCreate {
  name: string;
  priority: number;
}

interface RuleGroupUpdate {
  name?: string;
  priority?: number;
}

// OverrideRule: remove priorityScore, rename bucketId → groupId
interface OverrideRule {
  id: string;
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  groupId: string | null;   // null = ungrouped
  isActive: boolean;
  source: RuleSource;
  createdAt: string;
}
```

---

## UI Changes

### Rule Groups Panel (Rules page, was Buckets Panel)
- List of groups ordered by `priority DESC` (highest at top, applied first)
- Each group shows its priority number and rule count
- Drag to reorder — reassigns sequential priority integers to maintain uniqueness
- Inline priority number editing — service rejects if value < 1 or already taken by another group; UI shows inline validation error
- Inline rename, add new group, delete group
- Deleting a group moves its rules to ungrouped (does not delete the rules)
- **Ungrouped section** always shown at the bottom of the groups list, visually separated (dashed border or muted styling, label "Ungrouped — evaluated last"). It is a fixed UI indicator only — not a DB entity, not draggable, always at the bottom.

### Rules List Page
- Existing filter UI used to narrow the rule list
- Checkbox multi-select on filtered rows
- **"Add to group"** bulk action on selection → dropdown of existing groups → calls `rules:assignToGroup`
- **"Remove from group"** bulk action on selection → sets `group_id = NULL`
- Group column visible in list, filterable
- Ungrouped rules show "—" or "Ungrouped" in the group column

### Review Page — Active Group Selector

A toggle/selector in the review page toolbar that sets the **active group** for new rules created from the review page.

- Displays current active group (e.g. "Creating rules in: Client")
- Clicking opens a dropdown listing all rule groups (sorted by priority DESC) plus "Ungrouped"
- Selecting a group sets it as the active group — persisted in local UI state for the session (not in DB)
- Default on page load: highest-priority group (first in list)
- When a user creates a rule from the review page (override or classification correction), the rule is automatically assigned `group_id` of the currently active group
- If "Ungrouped" is selected, rules are created with `group_id = NULL`
- The selector is always visible on the review page, not hidden behind a settings panel — it directly communicates where new rules will go

### Review Page — Rule Attribution
- When a transaction is classified by a rule, show which group the rule belongs to
- Show "Ungrouped" if the matching rule has `group_id = NULL`

---

## Auto-Generated Rules

Rules created by the system (e.g., auto-classification corrections, bulk operations) are always created with `group_id = NULL` (ungrouped). Users manually assign them to a group if desired.

---

## Migration

1. Rename `rule_buckets` → `rule_groups`; drop `sort_order`, `is_default`, `grouped_conditions`; add `priority INTEGER NOT NULL UNIQUE CHECK (priority >= 1)` (seed from existing `sort_order`, offset to ensure >= 1)
2. Rename `override_rules.bucket_id` → `group_id`
3. Drop `override_rules.priority` / `priorityScore` column
4. Existing rules: all migrate to `group_id = NULL` (ungrouped) — no default groups created

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| Single query evaluation | Use `COALESCE(rg.priority, 0) DESC` in one query rather than two-phase | Simpler, same semantics, requires priority >= 1 constraint |
| Priority uniqueness | Enforced at DB level (`UNIQUE`) and service validation. UI shows inline error. No two groups can share a priority. | Deterministic evaluation order |
| Priority >= 1 | User-created group priorities must be at least 1 so COALESCE(priority, 0) always places ungrouped below named groups | Makes single-query approach work cleanly |
| Ungrouped is not an entity | No "Ungrouped" row in `rule_groups`. Ungrouped = `group_id IS NULL`. UI renders it as a fixed bottom section. | Avoids special-casing a pseudo-group throughout the codebase |
| Auto-generated rules | Always created ungrouped (`group_id = NULL`) | User decides intentionally which group auto-generated rules belong to |
| Within-group tie-break | Latest `created_at` wins | Deterministic, no user configuration needed |
| Review page active group | UI session state (not persisted in DB), defaults to highest-priority group on load | Simple; no backend changes needed for this preference |
