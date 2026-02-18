import type { CanonicalColumnDefinition } from './types/canonicalization';

/**
 * The 14 canonical columns used for AP classification.
 * Shared between backend (canonicalization agent) and frontend (ColumnMappingEditor).
 */
export const CANONICAL_COLUMNS: CanonicalColumnDefinition[] = [
  {
    name: 'supplier_name',
    relevance: 'critical',
    type: 'text',
    aliases: ['Vendor', 'Supplier', 'Company'],
    description: 'The name of the supplier or vendor',
  },
  {
    name: 'line_description',
    relevance: 'critical',
    type: 'log_text',
    aliases: ['Item', 'Description', 'Line Item'],
    description: 'Description of the line item',
  },
  {
    name: 'gl_description',
    relevance: 'high',
    type: 'log_text',
    aliases: ['GL', 'Account Description', 'Journal'],
    description: 'General ledger account description',
  },
  {
    name: 'spend_amount',
    relevance: 'critical',
    type: 'number',
    aliases: ['Amount', 'Cost', 'Price', 'Total'],
    description: 'The monetary amount of the transaction',
  },
  {
    name: 'gl_code',
    relevance: 'high',
    type: 'category',
    aliases: ['Account Code', 'GL Account'],
    description: 'General ledger account code',
  },
  {
    name: 'department',
    relevance: 'medium',
    type: 'category',
    aliases: ['Dept', 'Business Unit'],
    description: 'Department or business unit',
  },
  {
    name: 'invoice_date',
    relevance: 'high',
    type: 'date',
    aliases: ['Date', 'Invoice Date', 'Transaction Date'],
    description: 'Date of the invoice or transaction',
  },
  {
    name: 'creation_date',
    relevance: 'low',
    type: 'date',
    aliases: ['Created', 'Record Date'],
    description: 'Date the record was created',
  },
  {
    name: 'company',
    relevance: 'medium',
    type: 'category',
    aliases: ['Entity', 'Legal Entity'],
    description: 'The company or legal entity',
  },
  {
    name: 'cost_center',
    relevance: 'medium',
    type: 'category',
    aliases: ['Cost Center', 'Center'],
    description: 'Cost center identifier',
  },
  {
    name: 'po_number',
    relevance: 'low',
    type: 'text',
    aliases: ['PO', 'Purchase Order'],
    description: 'Purchase order number',
  },
  {
    name: 'supplier_address',
    relevance: 'low',
    type: 'text',
    aliases: ['Address', 'Supplier Address'],
    description: 'Address of the supplier',
  },
  {
    name: 'currency',
    relevance: 'low',
    type: 'category',
    aliases: ['Currency Code'],
    description: 'Currency code of the transaction',
  },
  {
    name: 'memo',
    relevance: 'low',
    type: 'log_text',
    aliases: ['Notes', 'Comments', 'Memo'],
    description: 'Additional notes or comments',
  },
];
