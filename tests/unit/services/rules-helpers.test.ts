import { describe, it, expect } from 'vitest';
import { extractSupplierNameCondition, decomposeConditions } from '../../../src/main/services/rules';
import type { GroupedFilter } from '../../../src/shared/types/transactions';
import type { OverrideRule } from '../../../src/shared/types/rules';

// ─── Factories ───────────────────────────────────────────────────────────────

function makeGroupedFilter(groups: GroupedFilter['groups'], groupConnector: 'AND' | 'OR' = 'AND'): GroupedFilter {
  return { groupConnector, groups };
}

function makeRule(groupedConditions: GroupedFilter): OverrideRule {
  return {
    id: 'r1',
    name: 'Test Rule',
    groupedConditions,
    targetTaxonomyNodeId: 'tid1',
    groupId: null,
    isActive: true,
    source: 'manual',
    categoryASupplier: false,
    createdAt: '',
  };
}

// ─── extractSupplierNameCondition ────────────────────────────────────────────

describe('extractSupplierNameCondition', () => {
  it('extracts supplier name from single supplier_name=X condition', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'AND',
      conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
    }]));
    expect(extractSupplierNameCondition(rule)).toBe('Acme');
  });

  it('extracts supplier name when mixed with other conditions in same group', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'AND',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
        { field: 'gl_description', operator: 'contains', value: 'software' },
      ],
    }]));
    expect(extractSupplierNameCondition(rule)).toBe('Acme');
  });

  it('returns null for multiple groups', () => {
    const rule = makeRule(makeGroupedFilter([
      { connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] },
      { connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Beta' }] },
    ]));
    expect(extractSupplierNameCondition(rule)).toBeNull();
  });

  it('extracts supplier name when OR connector wraps a single condition (connector is a no-op)', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'OR',
      conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
    }]));
    expect(extractSupplierNameCondition(rule)).toBe('Acme');
  });

  it('returns null for OR group connector with multiple conditions', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'OR',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
        { field: 'supplier_name', operator: 'equals', value: 'Beta' },
      ],
    }]));
    expect(extractSupplierNameCondition(rule)).toBeNull();
  });

  it('returns null when no supplier_name condition exists', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'AND',
      conditions: [{ field: 'gl_description', operator: 'contains', value: 'test' }],
    }]));
    expect(extractSupplierNameCondition(rule)).toBeNull();
  });

  it('returns null when supplier_name uses non-equals operator', () => {
    const rule = makeRule(makeGroupedFilter([{
      connector: 'AND',
      conditions: [{ field: 'supplier_name', operator: 'contains', value: 'Acme' }],
    }]));
    expect(extractSupplierNameCondition(rule)).toBeNull();
  });

  it('returns null for empty groups', () => {
    const rule = makeRule(makeGroupedFilter([]));
    expect(extractSupplierNameCondition(rule)).toBeNull();
  });
});

// ─── decomposeConditions ─────────────────────────────────────────────────────

describe('decomposeConditions', () => {
  it('decomposes single group with single condition', () => {
    const grouped = makeGroupedFilter([{
      connector: 'AND',
      conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
    }]);
    const rows = decomposeConditions('r1', grouped);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rule_id: 'r1',
      group_idx: 0,
      condition_idx: 0,
      field: 'supplier_name',
      operator: 'equals',
      value: 'Acme',
    });
  });

  it('decomposes multiple groups with OR connector', () => {
    const grouped: GroupedFilter = {
      groupConnector: 'OR',
      groups: [
        { connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] },
        { connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Beta' }] },
      ],
    };
    const rows = decomposeConditions('r1', grouped);

    expect(rows).toHaveLength(2);
    expect(rows[0].group_idx).toBe(0);
    expect(rows[1].group_idx).toBe(1);
  });

  it('preserves field, operator, value, and connectors', () => {
    const grouped = makeGroupedFilter([{
      connector: 'AND',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
        { field: 'gl_description', operator: 'contains', value: 'software' },
      ],
    }]);
    const rows = decomposeConditions('r1', grouped);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ field: 'supplier_name', operator: 'equals', value: 'Acme', condition_idx: 0 });
    expect(rows[1]).toMatchObject({ field: 'gl_description', operator: 'contains', value: 'software', condition_idx: 1 });
  });

  it('handles null value for nullary operators', () => {
    const grouped = makeGroupedFilter([{
      connector: 'AND',
      conditions: [{ field: 'notes', operator: 'is_null', value: null as any }],
    }]);
    const rows = decomposeConditions('r1', grouped);

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].operator).toBe('is_null');
  });

  it('returns empty array for empty groups', () => {
    const grouped = makeGroupedFilter([]);
    const rows = decomposeConditions('r1', grouped);
    expect(rows).toHaveLength(0);
  });

  it('indexes conditions sequentially within each group', () => {
    const grouped: GroupedFilter = {
      groupConnector: 'AND',
      groups: [
        { connector: 'AND', conditions: [
          { field: 'a', operator: 'equals', value: '1' },
          { field: 'b', operator: 'equals', value: '2' },
          { field: 'c', operator: 'equals', value: '3' },
        ]},
      ],
    };
    const rows = decomposeConditions('r1', grouped);

    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.condition_idx)).toEqual([0, 1, 2]);
    expect(rows.every(r => r.group_idx === 0)).toBe(true);
  });
});
