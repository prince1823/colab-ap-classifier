/**
 * Filter evaluation with SQL-like AND/OR operator precedence.
 *
 * AND binds tighter than OR:
 *   A AND B OR C  →  (A AND B) OR C
 *   A OR B AND C  →  A OR (B AND C)
 *
 * Two-phase algorithm:
 *   1. Group consecutive AND-connected conditions into "AND groups"
 *   2. Evaluate: each AND group passes if ALL its conditions are true,
 *      then OR the groups together (any group can pass).
 */

/**
 * Evaluate filter conditions with SQL-like AND/OR precedence.
 *
 * @param conditionEntries - Array of { key: string, result: boolean }
 * @param filterConnectors - Map of condition key → 'AND' | 'OR' (connector AFTER that condition)
 * @param filterCombinator - Global fallback combinator when no per-row connectors are set
 * @returns boolean - whether the row passes all filter conditions
 */
export function evaluateFilterConditions(
  conditionEntries: Array<{ key: string; result: boolean }>,
  filterConnectors: Record<string, 'AND' | 'OR'>,
  filterCombinator: 'AND' | 'OR' = 'AND'
): boolean {
  if (conditionEntries.length === 0) return true
  if (conditionEntries.length === 1) return conditionEntries[0].result

  const hasPerRowConnectors = Object.keys(filterConnectors).length > 0

  if (!hasPerRowConnectors) {
    // Fast path: no per-row connectors, use global combinator
    return filterCombinator === 'OR'
      ? conditionEntries.some(c => c.result)
      : conditionEntries.every(c => c.result)
  }

  // Phase 1: Build AND groups
  // Walk conditions left to right. OR connectors start a new group.
  // AND connectors (or missing = default AND) keep in current group.
  const andGroups: boolean[][] = [[conditionEntries[0].result]]

  for (let i = 1; i < conditionEntries.length; i++) {
    const prevKey = conditionEntries[i - 1].key
    const connector = filterConnectors[prevKey] || 'AND'

    if (connector === 'OR') {
      // Start a new AND group
      andGroups.push([conditionEntries[i].result])
    } else {
      // Continue current AND group
      andGroups[andGroups.length - 1].push(conditionEntries[i].result)
    }
  }

  // Phase 2: Evaluate
  // Each AND group passes if ALL conditions are true.
  // Final result: OR across all AND groups (any group can pass).
  return andGroups.some(group => group.every(result => result))
}

/**
 * Compute AND group membership for visual grouping in the filter panel UI.
 * Returns an array of group indices (0-based) parallel to the input keys.
 * Conditions in the same AND group share the same group index.
 *
 * @param conditionKeys - Array of backend keys in display order
 * @param filterConnectors - Map of condition key → 'AND' | 'OR'
 * @returns number[] - group index for each condition
 */
export function computeAndGroupIndices(
  conditionKeys: string[],
  filterConnectors: Record<string, 'AND' | 'OR'>
): number[] {
  if (conditionKeys.length === 0) return []

  const groupIndices: number[] = [0]
  let currentGroup = 0

  for (let i = 1; i < conditionKeys.length; i++) {
    const prevKey = conditionKeys[i - 1]
    const connector = filterConnectors[prevKey] || 'AND'

    if (connector === 'OR') {
      currentGroup++
    }
    groupIndices.push(currentGroup)
  }

  return groupIndices
}

/**
 * Build a human-readable expression preview showing how conditions are grouped.
 * Only shown when there are mixed AND/OR connectors (≥3 conditions with both AND and OR).
 *
 * Example output: "(Supplier AND GL) OR Line Desc"
 *
 * @param labels - Array of short labels for each condition (e.g. ["Supplier", "GL", "Line Desc"])
 * @param conditionKeys - Array of backend keys in display order
 * @param filterConnectors - Map of condition key → 'AND' | 'OR'
 * @returns string | null - expression string, or null if grouping is trivial (all AND or all OR)
 */
export function buildExpressionPreview(
  labels: string[],
  conditionKeys: string[],
  filterConnectors: Record<string, 'AND' | 'OR'>
): string | null {
  if (labels.length < 2) return null

  // Collect connectors between each pair
  const connectors: string[] = []
  for (let i = 0; i < conditionKeys.length - 1; i++) {
    connectors.push(filterConnectors[conditionKeys[i]] || 'AND')
  }

  // Only show preview when there's a mix of AND and OR (otherwise grouping is obvious)
  const hasAnd = connectors.includes('AND')
  const hasOr = connectors.includes('OR')
  if (!hasAnd || !hasOr) return null

  // Build AND groups of labels
  const groups: string[][] = [[labels[0]]]
  for (let i = 1; i < labels.length; i++) {
    const connector = connectors[i - 1]
    if (connector === 'OR') {
      groups.push([labels[i]])
    } else {
      groups[groups.length - 1].push(labels[i])
    }
  }

  // Format: groups with >1 member get parentheses, joined by OR
  const parts = groups.map(group => {
    if (group.length === 1) return group[0]
    return `(${group.join(' AND ')})`
  })

  return parts.join(' OR ')
}
