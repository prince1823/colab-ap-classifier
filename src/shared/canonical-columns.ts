import type { CanonicalColumnDefinition } from './types/column-mapping';

/**
 * All known canonical columns for AP classification.
 * The first three (supplier_name, spend_amount, invoice_date) are required —
 * importCSV will throw if any of them are absent from the mapping.
 * The rest are optional but well-known; the LLM will map them when present.
 * Any column the user adds manually beyond this list is stored as-is.
 */
export const CANONICAL_COLUMNS: CanonicalColumnDefinition[] = [
  // ── Required ──────────────────────────────────────────────────────────────
  {
    name: 'supplier_name',
    type: 'text',
    aliases: ['Vendor', 'Supplier', 'Company', 'Vendor Name', 'Payee'],
    description: 'The name of the supplier or vendor',
  },
  {
    name: 'spend_amount',
    type: 'number',
    aliases: ['Amount', 'Cost', 'Price', 'Total', 'Net Amount', 'Invoice Amount'],
    description: 'The monetary amount of the transaction',
  },
  {
    name: 'invoice_date',
    type: 'date',
    aliases: ['Date', 'Invoice Date', 'Transaction Date', 'Accounting Date', 'Posting Date'],
    description: 'Date of the invoice or transaction',
  },

  // ── Optional — well-known ─────────────────────────────────────────────────
  {
    name: 'line_description',
    type: 'text',
    aliases: ['Description', 'Line Item', 'Item Description', 'Line Description', 'Goods/Services Description'],
    description: 'Free-text description of what was purchased',
  },
  {
    name: 'gl_description',
    type: 'text',
    aliases: ['GL Desc', 'Account Description', 'Account Name', 'GL Account Description'],
    description: 'General ledger account description',
  },
  {
    name: 'gl_code',
    type: 'text',
    aliases: ['GL Code', 'Account Code', 'Account Number', 'GL Account', 'GL Account Code'],
    description: 'General ledger account code or number',
  },
  {
    name: 'department',
    type: 'text',
    aliases: ['Dept', 'Business Unit', 'Division', 'Cost Department', 'Org Unit'],
    description: 'Department or business unit responsible for the spend',
  },
  {
    name: 'company',
    type: 'text',
    aliases: ['Legal Entity', 'Entity', 'Business', 'Company Code', 'Company Name'],
    description: 'Legal entity or company within the group',
  },
  {
    name: 'cost_center',
    type: 'text',
    aliases: ['CC', 'Cost Centre', 'Cost Center Code', 'CC Code'],
    description: 'Cost centre code',
  },
  {
    name: 'creation_date',
    type: 'date',
    aliases: ['Created Date', 'Entry Date', 'Creation Date', 'Document Date'],
    description: 'Date the record was created in the source system',
  },
  {
    name: 'po_number',
    type: 'text',
    aliases: ['PO', 'Purchase Order', 'PO#', 'Purchase Order Number', 'PO Number'],
    description: 'Purchase order number',
  },
  {
    name: 'supplier_address',
    type: 'text',
    aliases: ['Address', 'Vendor Address', 'Supplier Address', 'Remit Address'],
    description: 'Primary address of the supplier',
  },
  {
    name: 'currency',
    type: 'text',
    aliases: ['Currency Code', 'CCY', 'ISO Currency', 'Transaction Currency'],
    description: 'ISO currency code for the transaction amount',
  },
  {
    name: 'memo',
    type: 'text',
    aliases: ['Notes', 'Comments', 'Remarks', 'Narration', 'Reference'],
    description: 'Free-text memo or notes attached to the transaction',
  },
];

/** The 3 required canonical column names. importCSV throws if any are missing. */
export const REQUIRED_CANONICAL_COLUMNS = ['supplier_name', 'spend_amount', 'invoice_date'] as const;
