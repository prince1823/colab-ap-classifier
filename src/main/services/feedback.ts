import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { logChange } from './changelog';
import { createRule } from './rules';
import type {
  SystemFeedback,
  FeedbackType,
  FeedbackActionDetails,
  FeedbackStatus,
  CompanyContextAction,
  TaxonomyDescriptionAction,
  SupplierRuleAction,
} from '../../shared/types';

interface FeedbackRow {
  id: string;
  feedback_type: string;
  affected_transaction_ids: string | null;
  suggestion: string;
  status: string;
  created_at: string;
}

function rowToFeedback(row: FeedbackRow): SystemFeedback {
  return {
    id: row.id,
    feedbackType: row.feedback_type as FeedbackType,
    affectedTransactionIds: row.affected_transaction_ids
      ? JSON.parse(row.affected_transaction_ids)
      : null,
    suggestion: JSON.parse(row.suggestion),
    status: row.status as FeedbackStatus,
    createdAt: String(row.created_at),
  };
}

/**
 * List all feedback entries, most recent first.
 */
export async function listFeedback(): Promise<SystemFeedback[]> {
  const rows = await databaseService.all<FeedbackRow>(
    'SELECT * FROM system_feedback ORDER BY created_at DESC'
  );
  return rows.map(rowToFeedback);
}

/**
 * Create a new feedback entry.
 */
export async function createFeedback(
  entry: Omit<SystemFeedback, 'id' | 'createdAt'>
): Promise<string> {
  const id = uuidv4();
  await databaseService.run(
    `INSERT INTO system_feedback (id, feedback_type, affected_transaction_ids, suggestion, status)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    entry.feedbackType,
    entry.affectedTransactionIds ? JSON.stringify(entry.affectedTransactionIds) : null,
    JSON.stringify(entry.suggestion),
    entry.status
  );
  return id;
}

/**
 * Approve a feedback suggestion and execute the associated action.
 */
export async function approveFeedback(
  feedbackId: string,
  modifications?: Partial<FeedbackActionDetails>
): Promise<void> {
  const row = await databaseService.get<FeedbackRow>(
    'SELECT * FROM system_feedback WHERE id = ?',
    feedbackId
  );

  if (!row) {
    throw new Error(`Feedback entry not found: ${feedbackId}`);
  }

  if (row.status !== 'pending') {
    throw new Error(`Feedback ${feedbackId} is already ${row.status}`);
  }

  const feedback = rowToFeedback(row);
  let suggestion = feedback.suggestion;

  // Apply modifications if provided
  if (modifications) {
    suggestion = { ...suggestion, ...modifications } as FeedbackActionDetails;
  }

  // Execute the suggestion based on type
  switch (feedback.feedbackType) {
    case 'company_context':
      await applyCompanyContext(suggestion as CompanyContextAction);
      break;
    case 'taxonomy_description':
      await applyTaxonomyDescription(suggestion as TaxonomyDescriptionAction);
      break;
    case 'supplier_rule':
      await applySupplierRule(suggestion as SupplierRuleAction);
      break;
    case 'uncategorized_feedback':
      // No auto-action for uncategorized feedback
      break;
  }

  // Log to changelog
  await logChange({
    source: 'manual',
    affectedTable: 'system_feedback',
    affectedIds: [feedbackId],
    affectedCount: 1,
    oldValues: { status: 'pending' },
    newValues: { status: 'approved', suggestion },
    description: `Approved feedback: ${feedback.feedbackType}`,
  });

  // Update status
  await databaseService.run(
    "UPDATE system_feedback SET status = 'approved', suggestion = ? WHERE id = ?",
    JSON.stringify(suggestion),
    feedbackId
  );
}

/**
 * Reject a feedback suggestion.
 */
export async function rejectFeedback(
  feedbackId: string,
  _reason?: string
): Promise<void> {
  const row = await databaseService.get<FeedbackRow>(
    'SELECT * FROM system_feedback WHERE id = ?',
    feedbackId
  );

  if (!row) {
    throw new Error(`Feedback entry not found: ${feedbackId}`);
  }

  if (row.status !== 'pending') {
    throw new Error(`Feedback ${feedbackId} is already ${row.status}`);
  }

  await databaseService.run(
    "UPDATE system_feedback SET status = 'rejected' WHERE id = ?",
    feedbackId
  );
}

/**
 * Apply a company_context feedback: update the company_context table.
 */
async function applyCompanyContext(action: CompanyContextAction): Promise<void> {
  const { fieldName, proposedValue } = action;

  // Map field name to database column
  const columnMap: Record<string, string> = {
    industry: 'industry',
    sector: 'sector',
    description: 'description',
    businessFocus: 'business_focus',
    procurementNuances: 'procurement_nuances',
  };

  const column = columnMap[fieldName];
  if (!column) {
    throw new Error(`Unknown company context field: ${fieldName}`);
  }

  // Check if company_context row exists
  const existing = await databaseService.get<{ id: string }>(
    'SELECT id FROM company_context LIMIT 1'
  );

  if (existing) {
    await databaseService.run(
      `UPDATE company_context SET ${column} = ? WHERE id = ?`,
      proposedValue,
      existing.id
    );
  }
}

/**
 * Apply a taxonomy_description feedback: update taxonomy node description.
 */
async function applyTaxonomyDescription(
  action: TaxonomyDescriptionAction
): Promise<void> {
  const { taxonomyPath, proposedDescription } = action;

  await databaseService.run(
    'UPDATE taxonomy SET description = ? WHERE full_path = ?',
    proposedDescription,
    taxonomyPath
  );
}

/**
 * Apply a supplier_rule feedback: create an override rule.
 */
async function applySupplierRule(action: SupplierRuleAction): Promise<void> {
  const { supplierName, classificationPaths } = action;

  if (classificationPaths.length === 0) return;

  // Find taxonomy node for the first classification path
  const taxonomyNode = await databaseService.get<{ id: string }>(
    'SELECT id FROM taxonomy WHERE full_path = ?',
    classificationPaths[0]
  );

  if (!taxonomyNode) return;

  await createRule({
    name: `Feedback Rule: ${supplierName}`,
    source: 'project',
    conditions: [
      { field: 'supplier_name', operator: 'equals', value: supplierName },
    ],
    targetTaxonomyNodeId: taxonomyNode.id,
  });
}
