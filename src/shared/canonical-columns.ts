import type { CanonicalColumnDefinition } from './types/column-mapping';

/**
 * The 3 required canonical columns for AP classification.
 * These are the only columns that need explicit CSV-to-canonical mapping.
 * All other CSV columns are handled as optional include/drop columns.
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
    name: 'spend_amount',
    relevance: 'critical',
    type: 'number',
    aliases: ['Amount', 'Cost', 'Price', 'Total'],
    description: 'The monetary amount of the transaction',
  },
  {
    name: 'invoice_date',
    relevance: 'critical',
    type: 'date',
    aliases: ['Date', 'Invoice Date', 'Transaction Date'],
    description: 'Date of the invoice or transaction',
  },
];

/** The 3 required canonical column names. Always sent to the classifier first. */
export const REQUIRED_CANONICAL_COLUMNS = ['supplier_name', 'spend_amount', 'invoice_date'] as const;
