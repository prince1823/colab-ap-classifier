## Summary

Define all shared TypeScript interfaces and types from the IPC contract and database models. These types are imported by both main and renderer processes.

## Scope

### Files to Create
- `src/shared/types/ipc.ts` — IPCResponse, channel type maps
- `src/shared/types/project.ts` — ProjectMetadata, CompanyContext, RecentProject
- `src/shared/types/transactions.ts` — Transaction, TransactionFilter, TransactionStats
- `src/shared/types/taxonomy.ts` — TaxonomyNode, TaxonomyMetadata, TaxonomySetInput, TaxonomyInfo
- `src/shared/types/suppliers.ts` — ProjectSupplier, SupplierInfo, SupplierType, SupplierUpdateInput, SupplierResearchResult
- `src/shared/types/rules.ts` — OverrideRule, RuleCondition, RuleOperator, RuleSource, OverrideRuleCreate, OverrideRuleUpdate
- `src/shared/types/classification.ts` — ClassificationStartOptions, ClassificationProgress, ClassificationScope, ProjectRun, ProjectRunStatus
- `src/shared/types/canonicalization.ts` — CanonicalizationResult, CanonicalColumnMapping, CSVPreview, ConfidenceLevel
- `src/shared/types/feedback.ts` — SystemFeedback, FeedbackType, FeedbackStatus, FeedbackActionDetails (union type)
- `src/shared/types/changelog.ts` — ChangeLog, ChangeSource
- `src/shared/types/settings.ts` — AppSettings, SettingsUpdateInput, ModelInfo, ProviderInfo
- `src/shared/types/index.ts` — Barrel export

### Key Type Definitions (from IPC contract)

```typescript
// Core response envelope
interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// All 53 IPC channel names as a const enum or string union
type IPCChannel = 'project:new' | 'project:open' | ... ;
```

### Acceptance Criteria
- [ ] All types from `internal_docs/ipc_contract.md` are defined
- [ ] All DB model types from `internal_docs/schema.md` are represented
- [ ] Barrel export from `src/shared/types/index.ts`
- [ ] TypeScript compiles with zero errors
- [ ] Types match the IPC contract exactly (field names, optionality)

## Dependencies
- **S1-01** (Project Scaffolding) — need the project structure to exist

## Spec References
- `internal_docs/ipc_contract.md` — all TypeScript interfaces
- `internal_docs/schema.md` — database models
