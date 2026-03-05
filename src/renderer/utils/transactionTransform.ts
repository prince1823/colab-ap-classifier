import type { Transaction, ClassificationStatus } from '../../shared/types/transactions'

export interface DashboardTransactionRow {
  id: string;
  supplierName: string;
  originalSupplierName: string;
  spendAmount: number;
  glDescription: string | null;
  classificationStatus: ClassificationStatus;
  humanReviewed: boolean;
  classificationPath: string | null;
  classificationReasoning: string | null;
  l1: string | null;
  l2: string | null;
  l3: string | null;
  taxonomyNodeId: string | null;
  glCode?: string;
  lineDescription?: string;
  costCenter?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  rowIndex: number;
  [key: string]: unknown;
}

export function toRow(t: Transaction): DashboardTransactionRow {
  const fields = t.canonicalFields as Record<string, unknown>
  const pathParts = t.classificationPath ? t.classificationPath.split('|') : []

  return {
    // Spread all canonical fields as raw values
    ...fields,

    // Typed fields
    id: t.id,
    supplierName: String(fields.supplier_name || ''),
    originalSupplierName: String(fields.original_supplier_name || fields.supplier_name || ''),
    spendAmount: Number(fields.spend_amount || 0),
    glDescription: fields.gl_description ? String(fields.gl_description) : null,
    classificationStatus: t.classificationStatus ?? 'unclassified',
    humanReviewed: t.humanReviewed ?? false,
    classificationPath: t.classificationPath || null,
    classificationReasoning: t.classificationReasoning || null,
    l1: pathParts[0]?.trim() || null,
    l2: pathParts[1]?.trim() || null,
    l3: pathParts[2]?.trim() || null,
    taxonomyNodeId: t.taxonomyNodeId,
    rowIndex: t.rowIndex,

    // Optional canonical fields
    glCode: fields.gl_code ? String(fields.gl_code) : undefined,
    lineDescription: fields.line_description ? String(fields.line_description) : undefined,
    costCenter: fields.cost_center ? String(fields.cost_center) : undefined,
    invoiceDate: fields.invoice_date ? String(fields.invoice_date) : undefined,
    invoiceNumber: fields.invoice_number ? String(fields.invoice_number) : undefined,

    // Legacy aliases for components that still use snake_case
    supplier_name: fields.supplier_name || '',
    gl_description: fields.gl_description || '',
    line_description: fields.line_description || '',
    spend_amount: fields.spend_amount || 0,
    classification_path: t.classificationPath || '',
    classification_status: t.classificationStatus ?? 'unclassified',
    taxonomy_node_id: t.taxonomyNodeId,
    classification_reasoning: t.classificationReasoning,
    row_index: t.rowIndex,
    L1: pathParts[0]?.trim() || null,
    L2: pathParts[1]?.trim() || null,
    L3: pathParts[2]?.trim() || null,
  }
}

export function toRows(ts: Transaction[]): DashboardTransactionRow[] {
  return ts.map(toRow)
}

/**
 * @deprecated Use toRow() instead. Kept for backward compatibility during migration.
 */
export function transactionToDashboardRow(t: Transaction, index: number): DashboardTransactionRow {
  return toRow(t)
}
