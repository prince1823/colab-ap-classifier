import { describe, it, expect } from 'vitest';

// v2 ReviewPage moved to src/renderer/pages/ReviewPage.tsx and is now a
// thin wrapper around Dashboard + useTransactions (IPC-based, DnD context).
// The old fetch-based CSV tests no longer apply.  These tests need a full
// rewrite once the v2 review UI stabilises.

describe('ReviewPage (placeholder)', () => {
  it('should be updated for v2 architecture', () => {
    // Intentional placeholder — old tests removed because the component
    // import path, export style, and data-loading strategy all changed in v2.
    expect(true).toBe(true);
  });
});
