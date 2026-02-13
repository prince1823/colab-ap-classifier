import type { Transaction } from '../../shared/types/transactions'

/**
 * Transforms a backend Transaction into the shape the Dashboard component expects.
 * This avoids refactoring the entire Dashboard component tree.
 */
export function transactionToDashboardRow(t: Transaction, index: number): Record<string, unknown> {
  const fields = t.canonicalFields as Record<string, unknown>
  const pathParts = t.classificationPath ? t.classificationPath.split('|') : []

  return {
    // Spread all canonical fields as raw values
    ...fields,

    // Standard fields the Dashboard expects
    supplier_name: fields.supplier_name || '',
    gl_description: fields.gl_description || '',
    line_description: fields.line_description || '',
    amount: fields.spend_amount || 0,
    invoice_amount: fields.spend_amount || 0,
    spend_amount: fields.spend_amount || 0,

    // Classification fields
    classification_path: t.classificationPath || '',
    taxonomy_path: t.classificationPath || '',
    L1: pathParts[0] || null,
    L2: pathParts[1] || null,
    L3: pathParts[2] || null,
    L4: pathParts[3] || null,

    // Metadata
    review_score: t.reviewScore ?? 0,
    row_index: t.rowIndex ?? index,
    id: t.id,
    taxonomy_node_id: t.taxonomyNodeId,
    classification_reasoning: t.classificationReasoning,
    invoice_group_key: t.invoiceGroupKey,
  }
}
