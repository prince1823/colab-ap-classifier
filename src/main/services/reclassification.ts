import { databaseService } from './database';
import { getNodes } from './taxonomy';
import { logChange } from './changelog';
import { getMetadata } from './project';
import { getSupplierByName } from './suppliers';
import { analyzeFeedback } from '../agents/feedback-agent';

/**
 * Reclassify one or more transactions to a new taxonomy node.
 *
 * 1. Validate taxonomy node exists
 * 2. Read current classification state (old_values)
 * 3. Update transactions
 * 4. Create changelog entry
 * 5. Optionally trigger feedback agent (awaited to avoid DuckDB mutex conflicts)
 */
export async function reclassifyTransactions(
  transactionIds: string[],
  taxonomyNodeId: string,
  feedback?: string
): Promise<void> {
  if (transactionIds.length === 0) {
    throw new Error('No transaction IDs provided');
  }

  // Validate taxonomy node exists
  const nodes = await getNodes();
  const targetNode = nodes.find((n) => n.id === taxonomyNodeId);
  if (!targetNode) {
    throw new Error(`Taxonomy node not found: ${taxonomyNodeId}`);
  }

  // Read current state
  const placeholders = transactionIds.map(() => '?').join(',');
  const currentRows = await databaseService.all<{
    id: string;
    taxonomy_node_id: string | null;
  }>(
    `SELECT id, taxonomy_node_id FROM transactions WHERE id IN (${placeholders})`,
    ...transactionIds
  );

  // Collect old taxonomy_node_id values
  const oldTaxonomyNodeIds = new Map<string, string | null>();
  for (const row of currentRows) {
    oldTaxonomyNodeIds.set(row.id, row.taxonomy_node_id);
  }

  // Update transactions
  await databaseService.run(
    `UPDATE transactions SET taxonomy_node_id = ?, classification_reasoning = NULL, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
    taxonomyNodeId,
    ...transactionIds
  );

  // Determine old values for changelog
  // Use the most common old value for simplicity
  const oldValues: Record<string, string | null> = {};
  const firstOldId = currentRows.length > 0 ? currentRows[0].taxonomy_node_id : null;
  oldValues.taxonomy_node_id = firstOldId;

  // Create changelog entry
  await logChange({
    source: 'manual',
    affectedTable: 'transactions',
    affectedIds: transactionIds,
    affectedCount: transactionIds.length,
    oldValues: { taxonomy_node_id: firstOldId },
    newValues: { taxonomy_node_id: taxonomyNodeId },
    description: `Reclassified ${transactionIds.length} transaction(s) to ${targetNode.fullPath}`,
  });

  // Trigger feedback agent if feedback text provided
  // NOTE: We await this to avoid concurrent DuckDB access (mutex lock errors).
  // The LLM call inside is the slow part, but DB reads/writes before and after
  // must not overlap with other IPC handlers (e.g., transactions:query refresh).
  if (feedback) {
    try {
      await triggerFeedbackAsync(transactionIds, firstOldId, targetNode.fullPath, feedback);
    } catch (err) {
      console.error('[Reclassification] Feedback agent error:', err);
    }
  }
}

/**
 * Trigger the feedback agent — gathers context, calls LLM, stores suggestion.
 */
async function triggerFeedbackAsync(
  transactionIds: string[],
  oldTaxonomyNodeId: string | null,
  newClassificationPath: string,
  userFeedback: string
): Promise<void> {
  // Get old classification path
  let oldClassificationPath = 'Unclassified';
  if (oldTaxonomyNodeId) {
    const nodes = await getNodes();
    const oldNode = nodes.find((n) => n.id === oldTaxonomyNodeId);
    if (oldNode) {
      oldClassificationPath = oldNode.fullPath;
    }
  }

  // Get company context
  let companyContext;
  try {
    const metadata = await getMetadata();
    companyContext = metadata.companyContext ?? { industry: 'Unknown' };
  } catch {
    companyContext = { industry: 'Unknown' };
  }

  // Get supplier info for the first transaction
  let supplierInfo;
  let parentName: string | null = null;
  try {
    const row = await databaseService.get<{ supplier_name: string }>(
      'SELECT supplier_name FROM transactions WHERE id = ?',
      transactionIds[0]
    );
    if (row?.supplier_name) {
      const supplier = await getSupplierByName(row.supplier_name);
      supplierInfo = supplier?.supplierInfo ?? undefined;
      parentName = supplier?.parentName ?? null;
    }
  } catch {
    // Ignore supplier lookup errors
  }

  const suggestion = await analyzeFeedback({
    transactionIds,
    oldClassificationPath,
    newClassificationPath,
    userFeedback,
    companyContext,
    supplierInfo,
    parentName,
  });

  // Store feedback in the system_feedback table
  const { v4: uuidv4 } = await import('uuid');
  const feedbackId = uuidv4();
  await databaseService.run(
    `INSERT INTO system_feedback (id, feedback_type, affected_transaction_ids, suggestion, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    feedbackId,
    suggestion.feedbackType,
    JSON.stringify(transactionIds),
    JSON.stringify(suggestion.suggestion)
  );
}
