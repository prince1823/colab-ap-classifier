import type { TaxonomyNode } from '../../shared/types/taxonomy';

/**
 * Resolve a pipe-delimited taxonomy path to its node ID.
 * Returns the matching node's id, or null if not found.
 */
export function resolveTaxonomyPath(
  path: string,
  nodes: TaxonomyNode[]
): string | null {
  const node = nodes.find((n) => n.fullPath === path);
  return node?.id ?? null;
}
