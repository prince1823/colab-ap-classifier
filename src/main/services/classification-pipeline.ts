import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { getNodes } from './taxonomy';
import { getMetadata } from './project';
import { researchBatch } from './supplier-research';
import { syncRulesFromSources, evaluateRules } from './rules';
import { getSuppliersByNames } from './suppliers';
import { classifyInvoiceGroup } from '../agents/classification-agent';
import { logChange } from './changelog';
import { AdaptiveRateLimiter, executeWithRateLimiter } from './rate-limiter';
import type {
  ClassificationStartOptions,
  ClassificationProgress,
  ProjectRunStatus,
  ProjectRun,
} from '../../shared/types';

// In-memory run tracker
let currentRun: ProjectRun | null = null;
let cancelledRunIds = new Set<string>();

// Reference to the main window for progress events
let mainWindowRef: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null = null;

export function setMainWindow(win: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null): void {
  mainWindowRef = win;
}

function emitProgress(progress: ClassificationProgress): void {
  if (mainWindowRef) {
    mainWindowRef.webContents.send('classification:progress', progress);
  }
}

function isCancelled(runId: string): boolean {
  return cancelledRunIds.has(runId);
}

function updateRun(updates: Partial<ProjectRun>): void {
  if (currentRun) {
    Object.assign(currentRun, updates);
  }
}

/**
 * Start the classification pipeline.
 */
export async function startClassification(
  options: ClassificationStartOptions
): Promise<{ runId: string }> {
  if (currentRun && ['pending', 'researching', 'classifying'].includes(currentRun.status)) {
    throw new Error('A classification job is already running');
  }

  const runId = uuidv4();
  currentRun = {
    id: runId,
    scope: options.scope,
    filterCriteria: options.filterCriteria ?? null,
    status: 'pending',
    progressTotal: 0,
    progressProcessed: 0,
    progressPercentage: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
  };

  // Run pipeline async
  runPipeline(runId, options).catch((err) => {
    if (currentRun && currentRun.id === runId) {
      currentRun.status = 'failed';
      currentRun.errorMessage = String(err);
      currentRun.completedAt = new Date().toISOString();
    }
  });

  return { runId };
}

/**
 * Get current classification status.
 */
export function getStatus(): ProjectRun | null {
  return currentRun ? { ...currentRun } : null;
}

/**
 * Cancel a running classification.
 */
export async function cancelClassification(runId: string): Promise<void> {
  cancelledRunIds.add(runId);
  if (currentRun && currentRun.id === runId) {
    const phase = currentRun.status === 'classifying' ? 'classifying' : 'researching';
    currentRun.status = 'cancelled';
    currentRun.completedAt = new Date().toISOString();

    // Immediately notify the frontend so the UI updates
    emitProgress({
      runId,
      status: 'cancelled',
      phase,
      total: currentRun.progressTotal,
      processed: currentRun.progressProcessed,
      percentage: currentRun.progressPercentage,
      currentStep: 'Cancelled',
    });
  }
}

/**
 * The full pipeline orchestration.
 */
async function runPipeline(
  runId: string,
  options: ClassificationStartOptions
): Promise<void> {
  try {
    // Step 1: Identify target rows
    const transactionIds = await identifyRows(options);

    if (transactionIds.length === 0) {
      updateRun({ status: 'completed', completedAt: new Date().toISOString() });
      return;
    }

    updateRun({
      status: 'researching',
      progressTotal: transactionIds.length,
      progressProcessed: 0,
    });

    emitProgress({
      runId,
      status: 'researching',
      phase: 'researching',
      total: transactionIds.length,
      processed: 0,
      percentage: 0,
      currentStep: 'Researching suppliers',
    });

    if (isCancelled(runId)) return;

    // Step 2: Supplier research
    const supplierNames = await getDistinctSupplierNames(transactionIds);
    if (supplierNames.length > 0) {
      await researchBatch(
        supplierNames,
        (done, total) => {
          // Don't emit researching progress if already cancelled —
          // otherwise it overwrites the 'cancelled' status in the frontend
          if (isCancelled(runId)) return;
          emitProgress({
            runId,
            status: 'researching',
            phase: 'researching',
            total,
            processed: done,
            percentage: total > 0 ? Math.round((done / total) * 100) : 0,
            currentStep: `Researched ${done}/${total} suppliers`,
          });
        },
        () => isCancelled(runId)
      );
    }

    if (isCancelled(runId)) return;

    // Step 3: Sync override rules
    await syncRulesFromSources();

    if (isCancelled(runId)) return;

    // Step 4: Apply override rules
    const ruleMatches = await evaluateRules(transactionIds);
    const matchedTxnIds = new Set<string>();

    // Pre-fetch all matched rule targets in one query
    const uniqueRuleIds = [...new Set(ruleMatches.values())];
    const ruleTargets = new Map<string, string>();
    if (uniqueRuleIds.length > 0) {
      const placeholders = uniqueRuleIds.map(() => '?').join(',');
      const rules = await databaseService.all<{ id: string; target_taxonomy_node_id: string }>(
        `SELECT id, target_taxonomy_node_id FROM override_rules WHERE id IN (${placeholders})`,
        ...uniqueRuleIds
      );
      for (const r of rules) {
        ruleTargets.set(r.id, r.target_taxonomy_node_id);
      }
    }

    // Group matched transactions by target node for bulk UPDATE
    const txnsByTargetNode = new Map<string, string[]>();
    for (const [txnId, ruleId] of ruleMatches.entries()) {
      const targetNodeId = ruleTargets.get(ruleId);
      if (targetNodeId) {
        let ids = txnsByTargetNode.get(targetNodeId);
        if (!ids) {
          ids = [];
          txnsByTargetNode.set(targetNodeId, ids);
        }
        ids.push(txnId);
        matchedTxnIds.add(txnId);
      }
    }
    for (const [targetNodeId, ids] of txnsByTargetNode) {
      const placeholders = ids.map(() => '?').join(',');
      await databaseService.run(
        `UPDATE transactions SET taxonomy_node_id = ?, review_score = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        targetNodeId,
        ...ids
      );
    }

    if (isCancelled(runId)) return;

    // Step 5: LLM classification for unmatched transactions
    const unmatchedIds = transactionIds.filter((id) => !matchedTxnIds.has(id));

    updateRun({
      status: 'classifying',
      progressTotal: unmatchedIds.length,
      progressProcessed: 0,
    });

    emitProgress({
      runId,
      status: 'classifying',
      phase: 'classifying',
      total: unmatchedIds.length,
      processed: 0,
      percentage: 0,
      currentStep: 'Classifying transactions',
    });

    if (unmatchedIds.length > 0) {
      const taxonomy = await getNodes();
      let metadata;
      try {
        metadata = await getMetadata();
      } catch {
        metadata = null;
      }
      const companyContext = metadata?.companyContext ?? {
        industry: 'Unknown',
      };

      // Get invoice grouping columns
      const groupingCols = await getInvoiceGroupingColumns();

      // Group transactions by invoice group
      const groups = await groupTransactionsByInvoice(unmatchedIds, groupingCols);

      // Pre-fetch all supplier research in bulk (1 query instead of N per-group)
      const uniqueSupplierNames = [
        ...new Set(
          groups
            .map((g) => g.transactions[0]?.supplier_name as string | undefined)
            .filter((n): n is string => !!n)
        ),
      ];
      const supplierMap = await getSuppliersByNames(uniqueSupplierNames);

      let processed = 0;
      const total = groups.length;

      // Adaptive rate limiter — starts at 8, halves on 429, recovers on success streaks
      const limiter = new AdaptiveRateLimiter({
        initialConcurrency: 8,
        minConcurrency: 1,
        maxConcurrency: 8,
        recoveryThreshold: 5,
      });

      // Helper to classify a single group
      const classifyGroup = async (group: TransactionGroup) => {
        const supplierName = group.transactions[0]?.supplier_name as string | undefined;
        let supplierResearch = null;
        let parentName: string | null = null;
        if (supplierName) {
          const supplier = supplierMap.get(supplierName);
          supplierResearch = supplier?.supplierInfo ?? null;
          parentName = supplier?.parentName ?? null;
        }

        const cleanedTxns = group.transactions.map((txn) => {
          const cleaned = { ...txn };
          if (typeof cleaned.gl_description === 'string') {
            cleaned.gl_description = cleanDescription(cleaned.gl_description);
          }
          return cleaned;
        });

        const result = await classifyInvoiceGroup({
          transactions: cleanedTxns,
          taxonomy,
          companyContext,
          supplierResearch,
          parentName,
          historicalClassifications: [],
        });

        const taxonomyNode = taxonomy.find(
          (n) => n.fullPath === result.classificationPath
        );

        return { result, taxonomyNodeId: taxonomyNode?.id ?? null };
      };

      // First pass: classify all groups with adaptive concurrency
      const firstPassResults = await executeWithRateLimiter(
        groups,
        limiter,
        async (group, _index) => {
          if (isCancelled(runId)) throw new Error('Cancelled');
          const outcome = await classifyGroup(group);

          // Write result immediately (sequential DB writes are fine — DuckDB single-writer)
          processed++;
          const reviewScore = outcome.result.descriptionSupplierAligned ? 0 : 50;
          const ids = group.transactionIds;
          if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            await databaseService.run(
              `UPDATE transactions SET taxonomy_node_id = ?, classification_reasoning = ?, review_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
              outcome.taxonomyNodeId,
              outcome.result.reasoning,
              reviewScore,
              ...ids
            );
          }

          updateRun({
            progressProcessed: processed,
            progressPercentage: total > 0 ? Math.round((processed / total) * 100) : 0,
          });

          // Don't emit classifying progress if already cancelled
          if (!isCancelled(runId)) {
            emitProgress({
              runId,
              status: 'classifying',
              phase: 'classifying',
              total,
              processed,
              percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
              currentStep: `Classified ${processed}/${total} groups`,
            });
          }

          return outcome;
        }
      );

      // Mark failed groups with sentinel (review_score = -1) so they're visible in Review tab
      const stillFailedGroups: TransactionGroup[] = [];
      for (let i = 0; i < firstPassResults.length; i++) {
        const r = firstPassResults[i];
        if (r.error) {
          const group = groups[i];
          const errMsg = r.error instanceof Error ? r.error.message : String(r.error);
          const ids = group.transactionIds;
          if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            await databaseService.run(
              `UPDATE transactions SET review_score = -1, classification_reasoning = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
              `Classification failed: ${errMsg}`,
              ...ids
            );
          }
          stillFailedGroups.push(group);
        }
      }

      // Retry pass: re-attempt failed groups with reduced concurrency
      if (stillFailedGroups.length > 0 && !isCancelled(runId)) {
        console.log(
          `[Pipeline] Retrying ${stillFailedGroups.length} failed groups with reduced concurrency`
        );

        const retryLimiter = new AdaptiveRateLimiter({
          initialConcurrency: 2,
          minConcurrency: 1,
          maxConcurrency: 4,
          recoveryThreshold: 3,
        });

        const retryResults = await executeWithRateLimiter(
          stillFailedGroups,
          retryLimiter,
          async (group) => {
            if (isCancelled(runId)) throw new Error('Cancelled');
            const outcome = await classifyGroup(group);
            const reviewScore = outcome.result.descriptionSupplierAligned ? 0 : 50;
            const ids = group.transactionIds;
            if (ids.length > 0) {
              const placeholders = ids.map(() => '?').join(',');
              await databaseService.run(
                `UPDATE transactions SET taxonomy_node_id = ?, classification_reasoning = ?, review_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
                outcome.taxonomyNodeId,
                outcome.result.reasoning,
                reviewScore,
                ...ids
              );
            }

            // Don't emit classifying progress if already cancelled
            if (!isCancelled(runId)) {
              emitProgress({
                runId,
                status: 'classifying',
                phase: 'classifying',
                total,
                processed: total,
                percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
                currentStep: `Retrying failed groups (${stillFailedGroups.length} remaining)`,
              });
            }

            return outcome;
          }
        );

        // Mark any groups that still failed after retry with sentinel
        for (let i = 0; i < retryResults.length; i++) {
          const r = retryResults[i];
          if (r.error) {
            const group = stillFailedGroups[i];
            const errMsg = r.error instanceof Error ? r.error.message : String(r.error);
            const ids = group.transactionIds;
            if (ids.length > 0) {
              const placeholders = ids.map(() => '?').join(',');
              await databaseService.run(
                `UPDATE transactions SET review_score = -1, classification_reasoning = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
                `Classification failed after retry: ${errMsg}`,
                ...ids
              );
            }
            console.error(`[Pipeline] Group permanently failed after retry:`, r.error);
          }
        }
      }
    }

    if (isCancelled(runId)) return;

    // Step 6: Finalize
    updateRun({
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    // Log to changelog
    const classifiedCount = transactionIds.length;
    await logChange({
      source: 'pipeline',
      affectedTable: 'transactions',
      affectedIds: transactionIds,
      affectedCount: classifiedCount,
      oldValues: null,
      newValues: { status: 'classified' },
      description: `Classification pipeline completed: ${classifiedCount} transactions processed`,
    });

    emitProgress({
      runId,
      status: 'completed',
      phase: 'classifying',
      total: transactionIds.length,
      processed: transactionIds.length,
      percentage: 100,
      currentStep: 'Completed',
    });

    // Clean up cancelled IDs
    cancelledRunIds.delete(runId);
  } catch (err) {
    if (!isCancelled(runId)) {
      updateRun({
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
    }
    throw err;
  }
}

/**
 * Identify target transaction IDs based on scope.
 */
async function identifyRows(
  options: ClassificationStartOptions
): Promise<string[]> {
  let sql = 'SELECT id FROM transactions';
  const params: unknown[] = [];

  if (options.scope === 'new') {
    sql += ' WHERE taxonomy_node_id IS NULL';
  } else if (options.scope === 'filtered' && options.filterCriteria) {
    const clauses: string[] = [];
    if (options.filterCriteria.supplierName) {
      clauses.push('supplier_name = ?');
      params.push(options.filterCriteria.supplierName);
    }
    if (options.filterCriteria.taxonomyNodeId) {
      clauses.push('taxonomy_node_id = ?');
      params.push(options.filterCriteria.taxonomyNodeId);
    }
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
  }

  const rows = await databaseService.all<{ id: string }>(sql, ...params);
  return rows.map((r) => r.id);
}

/**
 * Get distinct supplier names from a set of transactions.
 */
async function getDistinctSupplierNames(transactionIds: string[]): Promise<string[]> {
  if (transactionIds.length === 0) return [];

  try {
    const placeholders = transactionIds.map(() => '?').join(',');
    const rows = await databaseService.all<{ supplier_name: string }>(
      `SELECT DISTINCT supplier_name FROM transactions WHERE id IN (${placeholders}) AND supplier_name IS NOT NULL`,
      ...transactionIds
    );
    return rows.map((r) => r.supplier_name);
  } catch (err) {
    // Only swallow "column not found" — supplier_name may not exist if not mapped
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supplier_name') && (msg.includes('not found') || msg.includes('does not exist'))) {
      console.warn('[Pipeline] supplier_name column not found — skipping supplier research');
      return [];
    }
    // Re-throw unexpected errors (query timeout, DB locked, etc.)
    throw err;
  }
}

/**
 * Get configured invoice grouping columns.
 */
async function getInvoiceGroupingColumns(): Promise<string[]> {
  const rows = await databaseService.all<{ canonical_name: string }>(
    'SELECT canonical_name FROM invoice_grouping_columns ORDER BY position'
  );
  return rows.map((r) => r.canonical_name);
}

interface TransactionGroup {
  transactionIds: string[];
  transactions: Array<Record<string, unknown>>;
}

/**
 * Group transactions by invoice key (or treat each as own group).
 */
async function groupTransactionsByInvoice(
  transactionIds: string[],
  groupingColumns: string[]
): Promise<TransactionGroup[]> {
  if (transactionIds.length === 0) return [];

  const placeholders = transactionIds.map(() => '?').join(',');
  const rows = await databaseService.all<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE id IN (${placeholders})`,
    ...transactionIds
  );

  if (groupingColumns.length === 0) {
    // Each transaction is its own group
    return rows.map((row) => ({
      transactionIds: [row.id as string],
      transactions: [row],
    }));
  }

  // Group by the grouping columns
  const groups = new Map<string, TransactionGroup>();
  for (const row of rows) {
    const key = groupingColumns
      .map((col) => String(row[col] ?? ''))
      .join('|');

    if (!groups.has(key)) {
      groups.set(key, { transactionIds: [], transactions: [] });
    }
    const group = groups.get(key)!;
    group.transactionIds.push(row.id as string);
    group.transactions.push(row);
  }

  return Array.from(groups.values());
}

/**
 * Clean a description string — if ≥70% numeric characters, strip them.
 */
export function cleanDescription(desc: string): string {
  if (!desc) return desc;

  const numericChars = desc.replace(/[^0-9]/g, '').length;
  const totalChars = desc.replace(/\s/g, '').length;

  if (totalChars > 0 && numericChars / totalChars >= 0.7) {
    return desc.replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim();
  }

  return desc;
}

