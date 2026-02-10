# Sprint 1 Backend — Issue Dependency Graph

## Issue Index

| # | Title | Dependencies | Labels |
|---|-------|--------------|--------|
| S1-01 | Project Scaffolding | — | foundation |
| S1-02 | Shared TypeScript Types | S1-01 | foundation |
| S1-03 | IPC Infrastructure & Preload | S1-01, S1-02 | foundation, ipc |
| S1-04 | DuckDB Database Service | S1-01 | database |
| S1-05 | Project Service & IPC | S1-03, S1-04 | service, ipc |
| S1-06 | Recent Projects Service | S1-03, S1-05 | service, ipc |
| S1-07 | Settings Service | S1-03 | service, ipc |
| S1-08 | Upload Service — CSV Preview | S1-03, S1-05 | service, ipc |
| S1-09 | Canonicalization Agent | S1-02, S1-07 | llm-agent |
| S1-10 | Canonicalization Service & CSV Import | S1-04, S1-08, S1-09 | service, ipc |
| S1-11 | ColabIP Service | S1-03 | service, ipc |
| S1-12 | Taxonomy Service | S1-04, S1-11 | service, ipc |
| S1-13 | Supplier Service | S1-04, S1-05 | service, ipc |
| S1-14 | Research Agent | S1-02, S1-09 | llm-agent |
| S1-15 | Supplier Research Service | S1-13, S1-14 | service, ipc |
| S1-16 | Override Rules Service | S1-04, S1-11, S1-12, S1-13 | service, ipc |
| S1-17 | Changelog Service | S1-04, S1-03 | service, ipc |
| S1-18 | Transactions Service | S1-04, S1-10 | service, ipc |
| S1-19 | Classification Agent | S1-02, S1-09 | llm-agent, pipeline |
| S1-20 | Classification Pipeline | S1-15, S1-16, S1-18, S1-19, S1-12, S1-17 | pipeline |
| S1-21 | Reclassification Service | S1-18, S1-17, S1-12 | service, ipc |
| S1-22 | Feedback Agent | S1-02, S1-09 | llm-agent |
| S1-23 | Feedback Service | S1-04, S1-22, S1-17, S1-12, S1-16 | service, ipc |
| S1-24 | Export Service | S1-04, S1-18, S1-12 | service, ipc |
| S1-25 | Integration Tests | All above | testing |

## Dependency DAG (visual)

```
Layer 0 (no deps):
  S1-01 Project Scaffolding

Layer 1 (depends on S1-01):
  S1-02 Shared Types
  S1-04 DuckDB Service

Layer 2 (depends on Layer 0-1):
  S1-03 IPC Infrastructure  ← S1-01, S1-02
  S1-07 Settings Service     ← S1-03
  S1-11 ColabIP Service      ← S1-03

Layer 3 (depends on Layer 0-2):
  S1-05 Project Service      ← S1-03, S1-04
  S1-09 Canonicalization Agent ← S1-02, S1-07
  S1-12 Taxonomy Service     ← S1-04, S1-11
  S1-17 Changelog Service    ← S1-04, S1-03

Layer 4 (depends on Layer 0-3):
  S1-06 Recent Projects      ← S1-03, S1-05
  S1-08 Upload Service       ← S1-03, S1-05
  S1-13 Supplier Service     ← S1-04, S1-05
  S1-14 Research Agent       ← S1-02, S1-09
  S1-19 Classification Agent ← S1-02, S1-09
  S1-22 Feedback Agent       ← S1-02, S1-09

Layer 5 (depends on Layer 0-4):
  S1-10 Canon. Service + Import ← S1-04, S1-08, S1-09
  S1-15 Supplier Research     ← S1-13, S1-14
  S1-16 Override Rules        ← S1-04, S1-11, S1-12, S1-13

Layer 6 (depends on Layer 0-5):
  S1-18 Transactions Service  ← S1-04, S1-10

Layer 7 (depends on Layer 0-6):
  S1-20 Classification Pipeline ← S1-15, S1-16, S1-18, S1-19, S1-12, S1-17
  S1-21 Reclassification       ← S1-18, S1-17, S1-12
  S1-23 Feedback Service        ← S1-04, S1-22, S1-17, S1-12, S1-16
  S1-24 Export Service          ← S1-04, S1-18, S1-12

Layer 8 (final):
  S1-25 Integration Tests       ← All
```

## Recommended Implementation Order

Issues within the same batch can be worked on in parallel:

1. **Batch 1:** S1-01
2. **Batch 2:** S1-02, S1-04
3. **Batch 3:** S1-03, S1-11
4. **Batch 4:** S1-05, S1-07, S1-12, S1-17
5. **Batch 5:** S1-06, S1-08, S1-09, S1-13
6. **Batch 6:** S1-10, S1-14, S1-19, S1-22
7. **Batch 7:** S1-15, S1-16, S1-18
8. **Batch 8:** S1-20, S1-21, S1-23, S1-24
9. **Batch 9:** S1-25
