export type ClassificationStatus =
  | 'unclassified'
  | 'classified_by_rule'
  | 'classified_by_ai'
  | 'human_reviewed';

export interface ClassificationProgress {
  runId: string;
  status: 'pending' | 'researching' | 'classifying' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  phase: 'researching' | 'classifying';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
  total?: number;
  processed?: number;
}
