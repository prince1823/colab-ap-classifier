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
