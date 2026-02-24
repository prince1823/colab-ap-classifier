import type { SupplierUniverseRow } from './colabip';

/**
 * Normalize a supplier name for matching purposes.
 * Trims whitespace, collapses multiple spaces, and uppercases.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Pre-computed lookup index for O(1) supplier matching.
 * Build once with `buildMatcherIndex()`, then call `match()` per supplier.
 */
export interface SupplierMatcherIndex {
  match(rawName: string): SupplierUniverseRow | null;
}

/**
 * Build a pre-computed index from a supplier universe for fast lookups.
 * Normalizes all names and aliases once upfront, then each `match()` is O(1).
 */
export function buildMatcherIndex(universe: SupplierUniverseRow[]): SupplierMatcherIndex {
  const nameMap = new Map<string, SupplierUniverseRow>();
  const aliasMap = new Map<string, SupplierUniverseRow>();

  for (const row of universe) {
    const key = normalizeName(row.supplierName);
    // First writer wins — if two rows normalize to the same name, keep the first
    if (!nameMap.has(key)) {
      nameMap.set(key, row);
    }

    for (const alias of row.aliases) {
      const aliasKey = normalizeName(alias);
      if (!aliasMap.has(aliasKey)) {
        aliasMap.set(aliasKey, row);
      }
    }
  }

  return {
    match(rawName: string): SupplierUniverseRow | null {
      const key = normalizeName(rawName);
      // Exact name match takes priority over alias match
      return nameMap.get(key) ?? aliasMap.get(key) ?? null;
    },
  };
}

/**
 * Match a raw supplier name against the supplier universe.
 * Convenience wrapper for single lookups and tests — builds an index internally.
 * For repeated lookups (e.g. batch imports), use buildMatcherIndex() instead.
 *
 * @internal Not exported from the module — use buildMatcherIndex() in production code.
 */
export function matchSupplier(
  rawName: string,
  universe: SupplierUniverseRow[]
): SupplierUniverseRow | null {
  return buildMatcherIndex(universe).match(rawName);
}
