/**
 * Deduplication grouping utility for transaction batches.
 *
 * Groups transactions by their priority-column values so the LLM sees
 * one representative row per unique combination, with a count and the
 * list of transaction IDs that belong to each group.
 */

/** System/metadata columns to exclude from LLM prompts — not useful for classification. */
export const EXCLUDED_FIELDS = new Set([
  'id',
  'row_index',
  'created_at',
  'updated_at',
  'taxonomy_node_id',
  'classification_reasoning',
  'classification_status',
]);

/**
 * Extract the display fields for a transaction row based on column priorities.
 * Returns an array of [key, stringValue] pairs.
 */
export function extractFields(
  txn: Record<string, unknown>,
  columnPriorities?: string[]
): Array<[string, string]> {
  if (columnPriorities && columnPriorities.length > 0) {
    return columnPriorities
      .filter((k) => !EXCLUDED_FIELDS.has(k))
      .filter((k) => txn[k] !== null && txn[k] !== undefined && txn[k] !== '')
      .map((k) => [k, String(txn[k])] as [string, string]);
  }
  return Object.entries(txn)
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !EXCLUDED_FIELDS.has(k))
    .map(([k, v]) => [k, String(v)] as [string, string]);
}

export interface DedupGroup {
  groupNumber: number;
  fields: Array<[string, string]>;
  transactionIds: string[];
  count: number;
}

export interface DedupGroupResult {
  /** Formatted text for the LLM prompt */
  promptText: string;
  /** Map from 1-based group number to array of transaction IDs */
  groupToTransactionIds: Map<number, string[]>;
  /** Total number of groups */
  groupCount: number;
}

/**
 * Build deduplicated groups from a batch of transactions.
 *
 * Transactions are grouped by their priority-column values (via extractFields).
 * Each group tracks the count of rows AND the transaction IDs that belong to it.
 *
 * @param transactions - Array of transaction records
 * @param columnPriorities - Ordered list of columns to include (most important first)
 * @param idField - Name of the field holding the transaction ID (default: 'id')
 */
export function buildDedupGroups(
  transactions: Array<Record<string, unknown>>,
  columnPriorities: string[],
  idField: string = 'id'
): DedupGroupResult {
  const groups = new Map<string, { fields: Array<[string, string]>; ids: string[] }>();

  for (const txn of transactions) {
    const fields = extractFields(txn, columnPriorities);
    const key = JSON.stringify(fields);
    const existing = groups.get(key);
    const txnId = String(txn[idField] ?? '');

    if (existing) {
      existing.ids.push(txnId);
    } else {
      groups.set(key, { fields, ids: [txnId] });
    }
  }

  const groupToTransactionIds = new Map<number, string[]>();
  const parts: string[] = [];
  let groupIdx = 0;

  for (const { fields, ids } of groups.values()) {
    groupIdx++;
    const count = ids.length;
    const label = count === 1 ? '1 row' : `${count} rows`;
    const fieldStr = fields.map(([k, v]) => `  ${k}: ${v}`).join('\n');
    parts.push(`Group ${groupIdx} (${label}):\n${fieldStr}`);
    groupToTransactionIds.set(groupIdx, ids);
  }

  return {
    promptText: parts.join('\n\n'),
    groupToTransactionIds,
    groupCount: groupIdx,
  };
}
