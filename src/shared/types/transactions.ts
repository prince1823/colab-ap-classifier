export interface Transaction {
  id: string;
  rowIndex: number;
  invoiceGroupKey: string | null;

  taxonomyNodeId: string | null;
  classificationPath: string | null;
  reviewScore: number | null;
  classificationReasoning: string | null;

  canonicalFields: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
}

export interface ColumnFilter {
  column: string;
  operator: 'is' | 'is_not' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with';
  values: string[];
}

export interface TransactionFilter {
  supplierName?: string;
  taxonomyNodeId?: string;
  reviewScoreMin?: number;
  reviewScoreMax?: number;
  spendMin?: number;
  spendMax?: number;
  excludeTailSpend?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Arbitrary column-value filters for server-side filtering */
  columnFilters?: ColumnFilter[];
  /** Global combinator for column filters: AND (default) or OR */
  filterCombinator?: 'AND' | 'OR';
  /** Per-pair connectors between column filters (keyed by column name, value is connector AFTER that filter) */
  filterConnectors?: Record<string, 'AND' | 'OR'>;
}

export interface TransactionStats {
  totalRows: number;
  totalSpend: number;
  uniqueSuppliers: number;
  classifiedRows: number;
  flaggedForReviewRows: number;
}

/**
 * Paginated response for large dataset queries.
 */
export interface PaginatedTransactions {
  rows: Transaction[];
  totalCount: number;
  page: number;
  pageSize: number;
}

/**
 * A single grouped row: column value + aggregated amount and count.
 */
export interface GroupedRow {
  value: string;
  amount: number;
  count: number;
}

/**
 * Result of a server-side GROUP BY query for a column.
 */
export interface GroupedTransactionsResult {
  column: string;
  rows: GroupedRow[];
  totalAmount: number;
  totalCount: number;
}

/**
 * A single row from a server-side multi-level pivot aggregation.
 * dimensions[i] corresponds to the i-th dimension in the request.
 */
export interface PivotAggregationRow {
  dimensions: string[];
  amount: number;
  count: number;
}

/**
 * Result of a server-side pivot aggregation query.
 */
export interface PivotAggregationResult {
  dimensionColumns: string[];
  rows: PivotAggregationRow[];
  totalAmount: number;
  totalCount: number;
}
