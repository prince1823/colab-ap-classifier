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

/** Default maximum number of dedup groups per LLM call */
export const DEFAULT_GROUP_BATCH_SIZE = 300;

/**
 * Split a DedupGroupResult into batches of at most `batchSize` groups.
 *
 * Each batch gets its own contiguous 1-based group numbering so the LLM
 * prompt and validation stay consistent within a batch.
 */
export function batchDedupGroups(
  dedupResult: DedupGroupResult,
  batchSize: number = DEFAULT_GROUP_BATCH_SIZE
): DedupGroupResult[] {
  const { groupToTransactionIds, groupCount, promptText } = dedupResult;

  if (groupCount <= batchSize) {
    return [dedupResult];
  }

  const allEntries = Array.from(groupToTransactionIds.entries());
  const promptBlocks = promptText.split('\n\n');
  const batches: DedupGroupResult[] = [];

  for (let offset = 0; offset < allEntries.length; offset += batchSize) {
    const slice = allEntries.slice(offset, offset + batchSize);
    const batchMap = new Map<number, string[]>();

    slice.forEach(([, ids], idx) => {
      batchMap.set(idx + 1, ids);
    });

    const batchLines = promptBlocks.slice(offset, offset + batchSize).map((block, idx) => {
      return block.replace(/^Group \d+/, `Group ${idx + 1}`);
    });

    batches.push({
      promptText: batchLines.join('\n\n'),
      groupToTransactionIds: batchMap,
      groupCount: slice.length,
    });
  }

  return batches;
}

/**
 * Extract a sub-batch containing only the specified group numbers from an existing batch.
 *
 * Groups are re-numbered 1-based in the returned result so the LLM prompt
 * and validation stay consistent.
 *
 * @param batch - The original DedupGroupResult
 * @param groupNumbers - The 1-based group numbers to extract
 */
export function extractSubBatch(
  batch: DedupGroupResult,
  groupNumbers: number[]
): DedupGroupResult {
  const promptBlocks = batch.promptText.split('\n\n');
  const newMap = new Map<number, string[]>();
  const newParts: string[] = [];

  let newIdx = 0;
  for (const g of groupNumbers) {
    const ids = batch.groupToTransactionIds.get(g);
    if (!ids) continue;
    newIdx++;
    newMap.set(newIdx, ids);
    // promptBlocks are 0-indexed, group numbers are 1-indexed
    const block = promptBlocks[g - 1];
    if (block) {
      newParts.push(block.replace(/^Group \d+/, `Group ${newIdx}`));
    }
  }

  return {
    promptText: newParts.join('\n\n'),
    groupToTransactionIds: newMap,
    groupCount: newIdx,
  };
}
