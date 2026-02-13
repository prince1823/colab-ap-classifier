import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { getNodes } from './taxonomy';
import { getMetadata } from './project';
import { researchBatch } from './supplier-research';
import { syncRulesFromSources, evaluateRules } from './rules';
import { getSupplierByName } from './suppliers';
import { classifyInvoiceGroup } from '../agents/classification-agent';
import { logChange } from './changelog';
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
    currentRun.status = 'cancelled';
    currentRun.completedAt = new Date().toISOString();
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
      await researchBatch(supplierNames, (done, total) => {
        emitProgress({
          runId,
          status: 'researching',
          phase: 'researching',
          total,
          processed: done,
          percentage: total > 0 ? Math.round((done / total) * 100) : 0,
          currentStep: `Researched ${done}/${total} suppliers`,
        });
      });
    }

    if (isCancelled(runId)) return;

    // Step 3: Sync override rules
    await syncRulesFromSources();

    if (isCancelled(runId)) return;

    // Step 4: Apply override rules
    const ruleMatches = await evaluateRules(transactionIds);
    const matchedTxnIds: string[] = [];

    for (const [txnId, ruleId] of ruleMatches.entries()) {
      // Get the rule's target taxonomy node
      const rule = await databaseService.get<{ target_taxonomy_node_id: string }>(
        'SELECT target_taxonomy_node_id FROM override_rules WHERE id = ?',
        ruleId
      );
      if (rule) {
        await databaseService.run(
          'UPDATE transactions SET taxonomy_node_id = ?, review_score = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          rule.target_taxonomy_node_id,
          txnId
        );
        matchedTxnIds.push(txnId);
      }
    }

    if (isCancelled(runId)) return;

    // Step 5: LLM classification for unmatched transactions
    const unmatchedIds = transactionIds.filter((id) => !matchedTxnIds.includes(id));

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

      let processed = 0;
      const total = groups.length;

      for (const group of groups) {
        if (isCancelled(runId)) return;

        try {
          // Get supplier research if available
          const supplierName = group.transactions[0]?.supplier_name as string | undefined;
          let supplierResearch = null;
          if (supplierName) {
            const supplier = await getSupplierByName(supplierName);
            supplierResearch = supplier?.supplierInfo ?? null;
          }

          // Clean descriptions (strip if ≥70% numeric)
          const cleanedTxns = group.transactions.map((txn) => {
            const cleaned = { ...txn };
            if (typeof cleaned.gl_description === 'string') {
              cleaned.gl_description = cleanDescription(cleaned.gl_description);
            }
            return cleaned;
          });

          // Classify
          const result = await classifyInvoiceGroup({
            transactions: cleanedTxns,
            taxonomy,
            companyContext,
            supplierResearch,
            historicalClassifications: [],
          });

          // Find taxonomy node by path
          const taxonomyNode = taxonomy.find(
            (n) => n.fullPath === result.classificationPath
          );
          const taxonomyNodeId = taxonomyNode?.id ?? null;

          // Write results to transactions
          for (const txnId of group.transactionIds) {
            await databaseService.run(
              'UPDATE transactions SET taxonomy_node_id = ?, classification_reasoning = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              taxonomyNodeId,
              result.reasoning,
              txnId
            );
          }

          // Calculate review score based on alignment
          const reviewScore = result.descriptionSupplierAligned ? 0 : 50;
          for (const txnId of group.transactionIds) {
            await databaseService.run(
              'UPDATE transactions SET review_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              reviewScore,
              txnId
            );
          }
        } catch (err) {
          console.error(`[Pipeline] Failed to classify group:`, err);
          // Partial failure: continue with next group
        }

        processed++;
        updateRun({
          progressProcessed: processed,
          progressPercentage: total > 0 ? Math.round((processed / total) * 100) : 0,
        });

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

  // Check if supplier_name column exists
  try {
    const placeholders = transactionIds.map(() => '?').join(',');
    const rows = await databaseService.all<{ supplier_name: string }>(
      `SELECT DISTINCT supplier_name FROM transactions WHERE id IN (${placeholders}) AND supplier_name IS NOT NULL`,
      ...transactionIds
    );
    return rows.map((r) => r.supplier_name);
  } catch {
    return [];
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

