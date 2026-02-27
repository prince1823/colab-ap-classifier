# v2 Improvements

Future improvements and design decisions deferred from the v2 refactor.

---

## Linear → Incremental Pipeline

**Current:** The pipeline is linear — research ALL suppliers → user approves → classify ALL suppliers. This is simpler to implement, test, and reason about.

**Future:** Switch to incremental (per-supplier research+classify) if the supplier-based approach is working well. In incremental mode, classification could begin for approved suppliers while research continues for others. This would reduce total wall-clock time for large supplier sets.

The pipeline mediator (`src/main/services/pipeline.ts`) is designed so this transition only affects the mediator logic — classification and research services remain unchanged.
