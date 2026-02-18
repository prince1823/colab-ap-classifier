import { describe, it, expect } from 'vitest';
import { normalizeName, matchSupplier } from '../../../src/main/services/supplier-matcher';
import type { SupplierUniverseRow } from '../../../src/main/services/colabip';

/** Helper to create a minimal SupplierUniverseRow for tests. */
function makeRow(overrides: Partial<SupplierUniverseRow> = {}): SupplierUniverseRow {
  return {
    id: 'sup-001',
    supplierName: 'Acme Corp',
    aliases: [],
    parentId: null,
    parentName: '',
    categoryA: false,
    categoryATaxonomyPath: null,
    supplierInfo: null,
    ...overrides,
  };
}

describe('normalizeName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Acme Corp  ')).toBe('ACME CORP');
  });

  it('collapses multiple internal spaces to a single space', () => {
    expect(normalizeName('Acme   Corp')).toBe('ACME CORP');
  });

  it('uppercases the string', () => {
    expect(normalizeName('acme corp')).toBe('ACME CORP');
  });

  it('handles a combination of whitespace issues', () => {
    expect(normalizeName('  acme   corp   inc  ')).toBe('ACME CORP INC');
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(normalizeName('Acme\t\tCorp\n')).toBe('ACME CORP');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeName('   ')).toBe('');
  });

  it('handles single-word names', () => {
    expect(normalizeName('Amazon')).toBe('AMAZON');
  });
});

describe('matchSupplier', () => {
  const universe: SupplierUniverseRow[] = [
    makeRow({
      id: 'sup-acme',
      supplierName: 'Acme Corp',
      aliases: ['Acme Corporation', 'ACME'],
    }),
    makeRow({
      id: 'sup-ge',
      supplierName: 'GE Healthcare',
      aliases: ['GE Medical', 'GEHC'],
    }),
    makeRow({
      id: 'sup-ibm',
      supplierName: 'IBM',
      aliases: [],
    }),
  ];

  describe('exact normalized match', () => {
    it('matches exact name', () => {
      const result = matchSupplier('Acme Corp', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-acme');
    });

    it('matches case-insensitively', () => {
      const result = matchSupplier('acme corp', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-acme');
    });

    it('matches with extra whitespace', () => {
      const result = matchSupplier('  Acme   Corp  ', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-acme');
    });

    it('matches a single-word name', () => {
      const result = matchSupplier('ibm', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-ibm');
    });
  });

  describe('alias match', () => {
    it('matches an alias', () => {
      const result = matchSupplier('GE Medical', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-ge');
    });

    it('matches alias case-insensitively', () => {
      const result = matchSupplier('ge medical', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-ge');
    });

    it('matches alias with extra whitespace', () => {
      const result = matchSupplier('  GEHC  ', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-ge');
    });

    it('matches short alias form', () => {
      const result = matchSupplier('ACME', universe);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sup-acme');
    });
  });

  describe('no match', () => {
    it('returns null for unknown supplier', () => {
      const result = matchSupplier('Unknown Corp', universe);
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = matchSupplier('', universe);
      expect(result).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      const result = matchSupplier('   ', universe);
      expect(result).toBeNull();
    });
  });

  describe('priority', () => {
    it('prefers exact name match over alias match', () => {
      // Add a row where the supplier_name matches another row's alias
      const overlappingUniverse: SupplierUniverseRow[] = [
        makeRow({
          id: 'sup-alias-holder',
          supplierName: 'Original Inc',
          aliases: ['ACME'],
        }),
        makeRow({
          id: 'sup-acme-direct',
          supplierName: 'ACME',
          aliases: [],
        }),
      ];

      const result = matchSupplier('ACME', overlappingUniverse);
      expect(result).not.toBeNull();
      // Should match the direct name, not the alias
      expect(result!.id).toBe('sup-acme-direct');
    });
  });

  describe('empty universe', () => {
    it('returns null for empty universe', () => {
      const result = matchSupplier('Acme Corp', []);
      expect(result).toBeNull();
    });
  });
});
