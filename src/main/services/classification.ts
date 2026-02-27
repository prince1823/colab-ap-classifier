import { randomUUID } from 'crypto';
import { databaseService, supplierUniverseService } from './database';
import { getNodes } from './taxonomy';
import { getMetadata } from './project';
import { evaluateRules } from './rules';
import { updateTransactions } from './transactions';
import { classifyInvoiceGroup } from '../agents/classification-agent';
import { logChange } from './changelog';
import type { ClassificationProgress } from '../../shared/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isRunning = false;
let isPaused = false;
let isCancelled = false;
let currentRunId = '';

/** Reference to the main window for progress events */
let mainWindowRef: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null = null;

export function setMainWindow(win: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null): void {
  mainWindowRef = win;
}

function emitProgress(progress: Omit<ClassificationProgress, 'runId' | 'phase'> & { phase?: 'researching' | 'classifying' }): void {
  if (mainWindowRef) {
    const full: ClassificationProgress = {
      runId: currentRunId,
      phase: progress.phase ?? 'classifying',
      ...progress,
    };
    mainWindowRef.webContents.send('classification:progress', full);
  }
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export function getIsRunning(): boolean {
  return isRunning;
}

export function pause(): void {
  if (isRunning) isPaused = true;
}

export function resume(): void {
  isPaused = false;
}

export async function cancel(): Promise<void> {
  isCancelled = true;
  isPaused = false;

  emitProgress({
    status: 'cancelled',
    totalSuppliers: 0,
    processedSuppliers: 0,
    percentage: 0,
    currentSupplier: null,
    currentStep: 'Cancelled',
  });
}

/** Wait while paused (checked between suppliers). */
async function waitWhilePaused(): Promise<void> {
  while (isPaused && !isCancelled) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// ---------------------------------------------------------------------------
// Main classification loop
// ---------------------------------------------------------------------------

/**
 * Start classification.
 *
 * For each supplier with unclassified transactions that exists in supplier_universe.db:
 *   1. Apply override rules
 *   2. AI classify remaining unclassified rows
 *
 * Skips suppliers not in supplier_universe.db (research gate).
 * Resumable — skips suppliers whose transactions are already classified.
 */
export async function startClassification(): Promise<void> {
  if (isRunning) {
    throw new Error('Classification is already running');
  }

  isRunning = true;
  isPaused = false;
  isCancelled = false;
  currentRunId = randomUUID();

  try {
    // supplier_name is a dynamic column — guard against being called before CSV import
    const hasCol = await databaseService.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'supplier_name'"
    );

    // Get all distinct suppliers with unclassified transactions
    const supplierRows = hasCol.length === 0
      ? []
      : await databaseService.all<{ supplier_name: string }>(
          `SELECT DISTINCT supplier_name
           FROM transactions
           WHERE supplier_name IS NOT NULL AND classification_status = 'unclassified'
           ORDER BY supplier_name`
        );

    if (supplierRows.length === 0) {
      emitProgress({
        status: 'completed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 100,
        currentSupplier: null,
        currentStep: 'No unclassified transactions',
      });
      return;
    }

    // Filter to only suppliers that exist in supplier_universe.db (research gate)
    const supplierNames = supplierRows.map((r) => r.supplier_name);
    const researchedNames: string[] = [];

    for (const name of supplierNames) {
      const exists = await supplierUniverseService.get<{ id: string }>(
        'SELECT id FROM suppliers WHERE supplier_name = ?',
        name
      );
      if (exists) {
        researchedNames.push(name);
      }
    }

    if (researchedNames.length === 0) {
      emitProgress({
        status: 'failed',
        totalSuppliers: supplierNames.length,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: 'No suppliers have been researched. Run supplier research first.',
      });
      return;
    }

    const totalSuppliers = researchedNames.length;
    let processedSuppliers = 0;

    emitProgress({
      status: 'running',
      totalSuppliers,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: null,
      currentStep: 'Starting classification',
    });

    // Load shared data
    const taxonomy = await getNodes();
    let metadata;
    try {
      metadata = await getMetadata();
    } catch {
      metadata = null;
    }
    const companyContext = metadata?.companyContext ?? { industry: 'Unknown' };

    for (const supplierName of researchedNames) {
      if (isCancelled) break;
      await waitWhilePaused();
      if (isCancelled) break;

      emitProgress({
        status: isPaused ? 'paused' : 'running',
        totalSuppliers,
        processedSuppliers,
        percentage: totalSuppliers > 0 ? Math.round((processedSuppliers / totalSuppliers) * 100) : 0,
        currentSupplier: supplierName,
        currentStep: `Classifying: ${supplierName}`,
      });

      try {
        await classifySupplier(supplierName, taxonomy, companyContext as unknown as Record<string, unknown>);
      } catch (err) {
        console.error(`[Classification] Failed to classify supplier "${supplierName}":`, err);
        // Mark this supplier's unclassified transactions as failed
        const failedTxns = await databaseService.all<{ id: string }>(
          `SELECT id FROM transactions WHERE supplier_name = ? AND classification_status = 'unclassified'`,
          supplierName
        );
        if (failedTxns.length > 0) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await updateTransactions(
            {
              ids: failedTxns.map((t) => t.id),
              classificationReasoning: `Classification failed: ${errMsg}`,
            },
            'pipeline'
          );
        }
      }

      processedSuppliers++;
    }

    if (isCancelled) return;

    // Log to changelog
    const classifiedCount = await databaseService.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions WHERE classification_status != 'unclassified'`
    );
    await logChange({
      source: 'pipeline',
      affectedTable: 'transactions',
      affectedIds: [],
      affectedCount: Number(classifiedCount?.cnt ?? 0),
      oldValues: null,
      newValues: { status: 'classified' },
      description: `Classification completed: ${processedSuppliers} suppliers processed`,
    });

    emitProgress({
      status: 'completed',
      totalSuppliers,
      processedSuppliers: totalSuppliers,
      percentage: 100,
      currentSupplier: null,
      currentStep: 'Completed',
    });
  } catch (err) {
    if (!isCancelled) {
      emitProgress({
        status: 'failed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    isRunning = false;
    isPaused = false;
    isCancelled = false;
  }
}

// ---------------------------------------------------------------------------
// Per-supplier classification
// ---------------------------------------------------------------------------

async function classifySupplier(
  supplierName: string,
  taxonomy: Awaited<ReturnType<typeof getNodes>>,
  companyContext: Record<string, unknown>
): Promise<void> {
  // Step 1: Get unclassified transactions for this supplier
  const txnRows = await databaseService.all<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE supplier_name = ? AND classification_status = 'unclassified'`,
    supplierName
  );

  if (txnRows.length === 0) return;

  const txnIds = txnRows.map((r) => String(r.id));

  // Step 2: Apply override rules
  const ruleMatches = await evaluateRules(txnIds);

  // Group matched transactions by target node for bulk UPDATE
  const txnsByTargetNode = new Map<string, string[]>();
  const matchedTxnIds = new Set<string>();

  for (const [txnId, match] of ruleMatches.entries()) {
    let ids = txnsByTargetNode.get(match.targetTaxonomyNodeId);
    if (!ids) {
      ids = [];
      txnsByTargetNode.set(match.targetTaxonomyNodeId, ids);
    }
    ids.push(txnId);
    matchedTxnIds.add(txnId);
  }

  // Apply rule matches
  for (const [targetNodeId, ids] of txnsByTargetNode) {
    await updateTransactions(
      {
        ids,
        taxonomyNodeId: targetNodeId,
        classificationStatus: 'classified_by_rule',
        classificationReasoning: 'Matched override rule',
      },
      'rule'
    );
  }

  // Step 3: AI classify unmatched transactions
  const unmatchedTxns = txnRows.filter((r) => !matchedTxnIds.has(String(r.id)));

  if (unmatchedTxns.length === 0) return;

  // Get supplier research from universe
  const supplierRow = await supplierUniverseService.get<{ supplier_info: string | null; parent_name: string | null }>(
    'SELECT supplier_info, parent_name FROM suppliers WHERE supplier_name = ?',
    supplierName
  );

  let supplierResearch = null;
  let parentName: string | null = null;
  if (supplierRow) {
    try {
      supplierResearch = supplierRow.supplier_info
        ? (typeof supplierRow.supplier_info === 'string'
          ? JSON.parse(supplierRow.supplier_info)
          : supplierRow.supplier_info)
        : null;
    } catch { /* ignore */ }
    parentName = supplierRow.parent_name ?? null;
  }

  // Clean descriptions
  const cleanedTxns = unmatchedTxns.map((txn) => {
    const cleaned = { ...txn };
    if (typeof cleaned.gl_description === 'string') {
      cleaned.gl_description = cleanDescription(cleaned.gl_description);
    }
    return cleaned;
  });

  // Classify the batch
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

  // Apply classification
  const unmatchedIds = unmatchedTxns.map((r) => String(r.id));
  await updateTransactions(
    {
      ids: unmatchedIds,
      taxonomyNodeId: taxonomyNode?.id ?? undefined,
      classificationStatus: 'classified_by_ai',
      classificationReasoning: result.reasoning,
    },
    'pipeline'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
