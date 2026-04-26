# Filtering And Rule Logic Rewrite Plan

## Goal

Make every filtering and rule path consume the same canonical filter contract, so the same user-visible scope resolves to the same transaction, supplier, or rule set across pivot queries, rule creation, reclassification, classification scope runs, supplier views, CSV apply, and bulk rule evaluation.

## Current Red-Test Baseline

Initial guardrail tests were added before production changes:

- `tests/integration/filtering-risk-contracts.test.ts`
  - `applied_rule_name` filters must request the `override_rules` join everywhere they are accepted.
  - Supplier filters must preserve `OR` semantics when regular supplier fields and aggregate fields are mixed.
  - Rule filter-and-assign must use displayed group names consistently and must not prefilter away content-side `OR` matches.
- `tests/unit/services/classification.test.ts`
  - Scoped classification error marking must mutate only scoped unclassified rows.
- `tests/unit/services/supplier-service.test.ts`
  - CSV supplier alias matching and duplicate detection must use case-insensitive alias keys.

The targeted run currently fails on these new contracts, as expected for the red phase.

## Rewrite Shape

1. **Introduce a canonical filter compiler**
   - Create a small main-process filter compiler module that turns `GroupedFilter` into:
     - SQL predicate text and params.
     - Required joins.
     - Field metadata for transaction, supplier, and rule domains.
   - Keep `buildGroupedWhereClause` as the low-level expression builder or migrate it behind the new compiler.
   - The compiler must reject unknown fields loudly in service paths where silent fallback would produce wrong SQL.
   - Flat transaction/supplier `conditions` are not a separate architecture: renderer call sites now send one-group `GroupedFilter` values for simple filters.
   - The legacy `transactions:getIdsByConditions` IPC channel and transaction/supplier flat-filter service branches have been removed so ambiguous dual-shape inputs cannot silently choose a winner.

2. **Fix transaction filter join discovery**
   - Compute required joins from both selected dimensions and filter conditions.
   - Cover `supplier_name`, `parent_name`, taxonomy fields, `classification_path`, `applied_rule_name`, and `source_file`.
   - Apply this in `queryTransactions`, `getCount`, `queryGroupedByColumn`, `getTransactionIdsByColumnValue`, `getIdsByConditions`, `getIdsByGroupedConditions`, and `queryPivotAggregation`.
   - Preserve current simple-filter behavior covered by `tests/integration/filtering-current-behavior.test.ts`.

3. **Make pivot actions carry full active scope**
   - Add a renderer-side filter composition helper for:
     - pill filters,
     - advanced grouped filters,
     - flagged-only,
     - selected pivot row path segments.
   - `useReclassification` and `CreateRuleModal` should receive or build the same scoped `GroupedFilter` used by the visible pivot query.
   - Avoid large `id IN (...)` payloads except as a conflict-preview optimization for already-resolved candidate IDs.

4. **Align scoped classification mutations**
   - Decide and document the contract: scoped classification may inspect all scoped rows for supplier discovery, but LLM error marking mutates only scoped unclassified rows.
   - Push status filtering into SQL where possible instead of loading all supplier transactions and filtering in JS.
   - Revisit whether the rule phase should process all scoped rows or only unclassified scoped rows, then add the explicit contract test.

5. **Rewrite supplier aggregate filtering**
   - For pure regular filters, keep pushdown before aggregation.
   - For pure aggregate filters, aggregate then filter.
   - For mixed filters, especially `OR`, compile against a single supplier aggregate subquery so boolean grouping is preserved.
   - Add an in-memory reference evaluator for generated supplier fixtures before optimizing.

6. **Rewrite rule filter-and-assign**
   - Compile rule property fields against `override_rules r LEFT JOIN rule_groups rg`.
   - Treat `rule_group` values as display names, with `Ungrouped` mapping to `NULL`.
   - Preserve full grouped boolean semantics for property-only filters.
   - For mixed property/content filters, only prefilter predicates that cannot change the result, or compile content predicates to SQL over `rule_conditions`.

7. **Normalize supplier CSV apply keys**
   - Introduce one alias-key helper used by normalization, manual alias assignment, CSV diff, and CSV apply.
   - Detect duplicate aliases case-insensitively before checking whether aliases already exist in the DB.
   - Wrap `applyCsvDiff` in a transaction so parent, supplier, and alias mutations commit or roll back together.

8. **Keep bulk rule evaluation equivalent**
   - Expand the existing parity matrix with `in_list`, virtual columns, nullary boolean operators, and condition groups.
   - Preserve the single-pass bulk shape; avoid per-rule transaction scans.

## Rollout Order

1. Make the new red tests pass for transaction joins and scoped classification.
2. Extract the canonical filter compiler and migrate transaction methods.
3. Migrate supplier filters and rule filter-and-assign to the compiler.
4. Add renderer filter-composition tests, then wire pivot reclassification and rule creation through the composed filter.
5. Normalize CSV alias keys and transactional CSV apply.
6. Add performance fixtures for large pivot, rule, supplier, and CSV workloads.

## Verification

- Run targeted red/green suite:
  - `npm test -- tests/integration/filtering-risk-contracts.test.ts tests/unit/services/classification.test.ts tests/unit/services/supplier-service.test.ts`
- Run existing parity suite:
  - `npm test -- tests/integration/filter-rule-parity.test.ts`
- Run full unit and integration suite before merging:
  - `npm test`
  - `npm run typecheck`
