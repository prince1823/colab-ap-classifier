/**
 * Deduplication grouping utility for transaction batches.
 *
 * Groups transactions by their highest-priority column value (primary key).
 * Lower-priority columns are sampled using frequency weighting — the top N
 * most-common distinct values per column are shown as context.
 *
 * This reduces group counts dramatically compared to keying on full column
 * combinations (e.g. 8K groups vs 540K for a 99-supplier dataset).
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

/** Default number of sample values shown per lower-priority column. */
export const DEFAULT_SAMPLE_COUNT = 3;

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
  /** Structured group data for callers that need fields+count (e.g. tail-spend formatters) */
  groups: Array<{ fields: Array<[string, string]>; count: number }>;
}

/**
 * Build deduplicated groups from a batch of transactions.
 *
 * When `columnPriorities` is provided (the normal case), transactions are grouped
 * by their HIGHEST-priority column value only. Lower-priority columns contribute
 * up to `sampleCount` representative values each, chosen by frequency (most-common
 * first), shown as context within the group.
 *
 * When `columnPriorities` is empty, falls back to full-combination keying (original
 * behavior) — every unique combination of all non-excluded fields is its own group.
 *
 * @param transactions    - Array of transaction records
 * @param columnPriorities - Ordered list of columns (most important first)
 * @param sampleCount     - Max distinct values to sample per lower-priority column
 * @param idField         - Name of the field holding the transaction ID (default: 'id')
 */
export function buildDedupGroups(
  transactions: Array<Record<string, unknown>>,
  columnPriorities: string[],
  sampleCount: number = DEFAULT_SAMPLE_COUNT,
  idField: string = 'id'
): DedupGroupResult {
  // ── Fallback: no column priorities → full-combination keying (original behavior) ──
  if (columnPriorities.length === 0) {
    const legacyMap = new Map<string, { fields: Array<[string, string]>; ids: string[] }>();

    for (const txn of transactions) {
      const fields = extractFields(txn);
      const key = JSON.stringify(fields);
      const existing = legacyMap.get(key);
      const txnId = String(txn[idField] ?? '');
      if (existing) {
        existing.ids.push(txnId);
      } else {
        legacyMap.set(key, { fields, ids: [txnId] });
      }
    }

    const groupToTransactionIds = new Map<number, string[]>();
    const parts: string[] = [];
    const groups: Array<{ fields: Array<[string, string]>; count: number }> = [];
    let idx = 0;

    for (const { fields, ids } of legacyMap.values()) {
      idx++;
      const count = ids.length;
      const label = count === 1 ? '1 row' : `${count} rows`;
      parts.push(`Group ${idx} (${label}):\n${fields.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
      groupToTransactionIds.set(idx, ids);
      groups.push({ fields, count });
    }

    return { promptText: parts.join('\n\n'), groupToTransactionIds, groupCount: idx, groups };
  }

  // ── Primary-group sampling ────────────────────────────────────────────────
  const filteredCols = columnPriorities.filter((k) => !EXCLUDED_FIELDS.has(k));
  const primaryCol = filteredCols[0];
  const secondaryCols = filteredCols.slice(1);

  if (!primaryCol) {
    return { promptText: '', groupToTransactionIds: new Map(), groupCount: 0, groups: [] };
  }

  // Single pass: group by primary value, frequency-count secondary column values
  const primaryMap = new Map<string, {
    ids: string[];
    freq: Map<string, Map<string, number>>;
  }>();

  for (const txn of transactions) {
    const primaryVal = txn[primaryCol];
    if (primaryVal === null || primaryVal === undefined || primaryVal === '') continue;

    const key = String(primaryVal);
    const txnId = String(txn[idField] ?? '');

    let entry = primaryMap.get(key);
    if (!entry) {
      const freq = new Map<string, Map<string, number>>();
      for (const col of secondaryCols) {
        freq.set(col, new Map());
      }
      entry = { ids: [], freq };
      primaryMap.set(key, entry);
    }

    entry.ids.push(txnId);

    for (const col of secondaryCols) {
      const val = txn[col];
      if (val === null || val === undefined || val === '') continue;
      const valStr = String(val);
      const colFreq = entry.freq.get(col)!;
      colFreq.set(valStr, (colFreq.get(valStr) ?? 0) + 1);
    }
  }

  // Build output
  const groupToTransactionIds = new Map<number, string[]>();
  const parts: string[] = [];
  const groups: Array<{ fields: Array<[string, string]>; count: number }> = [];
  let groupIdx = 0;

  for (const [primaryVal, { ids, freq }] of primaryMap) {
    groupIdx++;
    const count = ids.length;
    const label = count === 1 ? '1 row' : `${count} rows`;

    const fields: Array<[string, string]> = [[primaryCol, primaryVal]];

    for (const col of secondaryCols) {
      const colFreq = freq.get(col)!;
      if (colFreq.size === 0) continue;

      const totalDistinct = colFreq.size;
      const samples = [...colFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, sampleCount)
        .map(([v]) => v);

      const display =
        totalDistinct > sampleCount
          ? `(${samples.length} of ${totalDistinct}): ${samples.join(', ')}`
          : samples.join(', ');

      fields.push([col, display]);
    }

    parts.push(`Group ${groupIdx} (${label}):\n${fields.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
    groupToTransactionIds.set(groupIdx, ids);
    groups.push({ fields, count });
  }

  return { promptText: parts.join('\n\n'), groupToTransactionIds, groupCount: groupIdx, groups };
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
  const { groupToTransactionIds, groupCount, promptText, groups } = dedupResult;

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
      groups: groups.slice(offset, offset + batchSize),
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
  const newGroups: Array<{ fields: Array<[string, string]>; count: number }> = [];

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
    const groupData = batch.groups[g - 1];
    if (groupData) newGroups.push(groupData);
  }

  return {
    promptText: newParts.join('\n\n'),
    groupToTransactionIds: newMap,
    groupCount: newIdx,
    groups: newGroups,
  };
}
