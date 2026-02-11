import type { TransactionFilter } from './transactions';

export type ClassificationScope = 'all' | 'new' | 'filtered';

export type ProjectRunStatus =
  | 'pending'
  | 'researching'
  | 'classifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ClassificationStartOptions {
  scope: ClassificationScope;
  filterCriteria?: TransactionFilter;
}

export interface ClassificationProgress {
  runId: string;
  status: ProjectRunStatus;
  phase: 'researching' | 'classifying';
  total: number;
  processed: number;
  percentage: number;
  currentStep: string;
}

/** In-memory run state — not persisted to any database table. */
export interface ProjectRun {
  id: string;
  scope: ClassificationScope;
  filterCriteria: TransactionFilter | null;
  status: ProjectRunStatus;
  progressTotal: number;
  progressProcessed: number;
  progressPercentage: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}
