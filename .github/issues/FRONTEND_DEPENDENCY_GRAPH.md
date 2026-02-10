# Sprint 1 Frontend Track — Issue Dependency Graph

> See [DEPENDENCY_GRAPH.md](./DEPENDENCY_GRAPH.md) for the backend track.

## Cross-Track Prerequisites

These backend issues must be closed before certain frontend issues can start:

| Backend Issue | Required By | Reason |
|---------------|-------------|--------|
| S1-01 (Project Scaffolding) | All frontend issues | Electron app shell, build tooling |
| S1-02 (Shared Types) | All frontend issues using IPC types | TypeScript interfaces for IPC contract |
| S1-03 (IPC Infrastructure & Preload) | All frontend issues calling IPC | contextBridge, preload script |
| S1-05 (Project Service) | Project selector, settings pages | project:new, project:open, project:getMetadata |
| S1-06 (Recent Projects) | Project selector | project:getRecent |
| S1-07 (Settings Service) | Project settings page | settings:get, settings:set |
| S1-08 (Upload Service) | Upload page | upload:parseCSV, upload:preview |
| S1-10 (Canonicalization Service) | Canonicalization page | canonicalization:suggest, canonicalization:confirm |
| S1-12 (Taxonomy Service) | Taxonomy store, classification pages | taxonomy:getTree, taxonomy:add, taxonomy:rename |
| S1-13 (Supplier Service) | Supplier database page | supplier:list, supplier:update |
| S1-15 (Supplier Research Service) | Supplier database page | supplier:research |
| S1-16 (Override Rules Service) | Override rules page | rules:list, rules:create, rules:evaluate |
| S1-17 (Changelog Service) | Version history page | changelog:list, changelog:revert |
| S1-18 (Transactions Service) | Data review, review pages | transactions:query, transactions:getStats |
| S1-20 (Classification Pipeline) | Classification page | classification:start, classification:pause |
| S1-21 (Reclassification Service) | Review page (reclassification) | reclassification:apply, reclassification:undo |
| S1-23 (Feedback Service) | Feedback dashboard | feedback:list, feedback:approve |
| S1-24 (Export Service) | Output/export page | export:csv |

## Issue Index

_Frontend issues to be defined. Use the table format below:_

| # | Title | Frontend Dependencies | Backend Prerequisites | Labels |
|---|-------|----------------------|----------------------|--------|
| <!-- FE-01 | App Shell & Tab Layout | — | S1-01, S1-03 | foundation, page --> |
| <!-- FE-02 | Project Selector & Dialogs | FE-01 | S1-05, S1-06 | component, page --> |
| <!-- ... add frontend issues here ... --> |

## Dependency DAG (visual)

_To be populated when frontend issues are created._

```
Layer 0 (no frontend deps, backend prereqs only):
  FE-01 App Shell & Tab Layout          ← backend: S1-01, S1-03

Layer 1 (depends on FE Layer 0):
  FE-02 Project Selector & Dialogs      ← FE-01, backend: S1-05, S1-06
  FE-XX Taxonomy Store Page             ← FE-01, backend: S1-12
  FE-XX Company Context Page            ← FE-01, backend: S1-05
  FE-XX Supplier Database Page          ← FE-01, backend: S1-13, S1-15
  FE-XX Override Rules Page             ← FE-01, backend: S1-16
  FE-XX Version History Page            ← FE-01, backend: S1-17

Layer 2:
  FE-XX Project Settings Page           ← FE-02, backend: S1-07, S1-12
  FE-XX Upload Page                     ← FE-01, backend: S1-08

Layer 3:
  FE-XX Canonicalization Page            ← FE-XX (Upload), backend: S1-10

Layer 4:
  FE-XX Data Review Page                ← FE-XX (Canonicalization), backend: S1-18

Layer 5:
  FE-XX Classification Page             ← FE-XX (Data Review), backend: S1-20

Layer 6:
  FE-XX Review Page — Table & Filters   ← FE-XX (Classification), backend: S1-18, S1-21
  FE-XX Output/Export Page              ← FE-XX (Classification), backend: S1-24

Layer 7:
  FE-XX Review Page — Taxonomy & Reclass ← FE-XX (Review Table), backend: S1-12, S1-21
  FE-XX Review Page — Feedback Panel    ← FE-XX (Review Table), backend: S1-23
  FE-XX Feedback Dashboard              ← FE-XX (Review Table), backend: S1-23

Layer 8 (final):
  FE-XX Frontend Integration Tests       ← All above
```

## Recommended Implementation Order

Issues within the same batch can be worked on in parallel:

1. **Batch 1:** FE-01 (App Shell)
2. **Batch 2:** FE-02 (Project Selector), standalone store pages (Taxonomy, Company Context, Supplier DB, Rules, History)
3. **Batch 3:** Project Settings, Upload Page
4. **Batch 4:** Canonicalization Page
5. **Batch 5:** Data Review Page
6. **Batch 6:** Classification Page
7. **Batch 7:** Review Page (table + filters), Output Page
8. **Batch 8:** Review Page (taxonomy + reclass, feedback panel), Feedback Dashboard
9. **Batch 9:** Frontend Integration Tests
