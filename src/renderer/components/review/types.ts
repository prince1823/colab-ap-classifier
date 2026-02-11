export type LogicalOperator = 'AND' | 'OR';

export type FilterOperator =
  | 'equals'
  | 'contains'
  | 'greater_than'
  | 'less_than'
  | 'in'
  | 'not_equals';

export interface ColumnConfig {
  id: string;
  label: string;
  accessorKey: string;
  isDefault?: boolean;
}

export interface TableFilter {
  id: string;
  columnId: string;
  operator: FilterOperator;
  value: string;
}

export interface ReviewRow {
  id: string;
  supplierName: string;
  lineDescription: string;
  classificationPath: string;
  l1: string | null;
  l2: string | null;
  l3: string | null;
  l4: string | null;
  spendAmount: number;
  reviewScore: number;
  overrideRuleApplied: string | null;
  raw: Record<string, string>;
}

export interface MetricsSummary {
  totalRows: number;
  totalSpend: number;
  filteredRows: number;
  filteredSpend: number;
  flaggedPending: number;
  flaggedReviewed: number;
  averageReviewScore: number | null;
}

