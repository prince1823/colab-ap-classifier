export type ChangeSource = 'manual' | 'pipeline' | 'rule' | 'feedback';

export interface ChangeLog {
  id: string;
  source: ChangeSource;
  affectedTable: string;
  affectedIds: string[];
  affectedCount: number;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  description: string | null;
  createdAt: string;
  isReverted?: boolean;
  /** Computed at read-time: supplier names for transaction changes */
  supplierNames?: string[];
}

export interface ChangelogFilter {
  search?: string;
  viewFilter?: 'all' | 'changes' | 'feedback';
  page?: number;
  pageSize?: number;
}

export interface PaginatedChangelog {
  rows: ChangeLog[];
  totalCount: number;
  page: number;
  pageSize: number;
}
