import type { ClassificationStatus } from './classification';

export interface Transaction {
  id: string;
  rowIndex: number;
  taxonomyNodeId: string | null;
  classificationPath: string | null;
  classificationStatus: ClassificationStatus;
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
  /** Grouped conditions with proper parenthesization (takes precedence over conditions if set) */
  groupedConditions?: GroupedFilter;
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

/** A group of conditions joined by a single connector (all AND or all OR within the group). */
export interface ConditionGroup {
  /** How conditions within this group are joined. */
  connector: 'AND' | 'OR';
  conditions: FilterCondition[];
  /** How this group connects to the PREVIOUS group. Ignored on the first group. Defaults to groupConnector if omitted. */
  groupConnector?: 'AND' | 'OR';
}

/** Grouped filter: multiple groups joined by a top-level connector. */
export interface GroupedFilter {
  /** How groups are joined to each other. */
  groupConnector: 'AND' | 'OR';
  groups: ConditionGroup[];
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

export type FieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  enumValues?: string[];
  /** Autocomplete suggestions for string fields — renders a <datalist> while keeping all string operators */
  suggestions?: string[];
  /** Optional group name — fields with the same group render under a shared <optgroup> */
  group?: string;
}

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
