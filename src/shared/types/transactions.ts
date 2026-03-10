import type { ClassificationStatus } from './classification';

export interface Transaction {
  id: string;
  rowIndex: number;
  taxonomyNodeId: string | null;
  classificationPath: string | null;
  classificationStatus: ClassificationStatus;
  classificationReasoning: string | null;
  humanReviewed: boolean;
  canonicalFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionFilter {
  supplierName?: string;
  taxonomyNodeId?: string;
  classificationStatus?: ClassificationStatus;
  spendMin?: number;
  spendMax?: number;
  /** Generic conditions using the same shape as override rules */
  conditions?: FilterCondition[];
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: string | number | string[];
  /** How this condition joins to the next. Default: 'AND'. Ignored on last condition. */
  connector?: 'AND' | 'OR';
}

export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'regex'
  | 'in_list'
  | 'is_null'
  | 'is_true'
  | 'is_false'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal';

export interface TransactionStats {
  totalRows: number;
  totalSpend: number;
  uniqueSuppliers: number;
  classifiedRows: number;
  unclassifiedRows: number;
}

export interface PaginatedTransactions {
  rows: Transaction[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface TransactionUpdate {
  ids: string[];
  taxonomyNodeId?: string;
  classificationStatus?: ClassificationStatus;
  classificationReasoning?: string;
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
