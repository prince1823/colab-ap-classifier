# Cat A Resolution Conundrum

## The Problem

When `resolveCatASupplier` runs during research and all taxonomy path resolutions fail (LLM can't map the universe paths to the project taxonomy), there's a design tension between two goals:

1. **Data integrity** — only mark `categoryASupplier: true` when an override rule actually exists, so the flag is meaningful and consistent with `override_rules`.
2. **UX / transparency** — show the user that a supplier IS Category A (from the universe), even if the rule couldn't be auto-created, so they know to handle it manually.

## What We Decided

**Data integrity wins.** `categoryASupplier: true` is only set on the project supplier when a rule is successfully created. If all paths fail to resolve, the flag stays `false` and no badge shows.

**Rationale:**
- The delete cascade in `rules:delete` clears `categoryASupplier: false` when the last Cat A rule is removed. If we mark the flag without a rule, there's no cascade path to ever clear it — the badge becomes permanently sticky with no way for the user to remove it through normal UI.
- The manual Cat A toggle on the Rules page operates on an existing rule. With no rule, the user has no affordance to manage the Cat A state.
- A false `categoryASupplier: true` with no rule could confuse downstream logic that assumes the flag implies a rule exists.

**Instead, transparency is achieved via the research progress warning:**

When any Cat A resolutions fail, `researchAll` increments `catAResolveFailed` and surfaces it in the completed event's `currentStep`:

```
"Completed — 2 Cat A suppliers could not be mapped to project taxonomy"
```

This renders as an amber warning bar on the Suppliers page. The user knows something needs attention without the data model becoming inconsistent.

## What the User Should Do

When they see the Cat A resolution warning:

1. Check Override Rules — those suppliers will have no Cat A rule.
2. Either fix the project taxonomy to include the expected paths, or create a manual override rule and toggle it as Cat A.
3. Re-run research — `resolveCatASupplier` skips suppliers that already have a Cat A rule, so it will retry the ones that failed.

## Why This Came Up

During the silent-failure audit (branch `fix/silent-failure-audit`, PR #398), the original code already marked `categoryASupplier: true` unconditionally at the end of `resolveCatASupplier` — but this was identified as problematic for the reasons above. The fix moved `updateSupplier({ categoryASupplier: true })` inside the success branch (after rule creation), and added the warning count to surface failures without polluting the data model.
