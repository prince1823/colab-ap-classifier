import type { TaxonomyNode } from './taxonomy';
import type { CompanyContext } from './project';
import type { SupplierInfo } from './suppliers';

export type ClassificationStatus =
  | 'unclassified'
  | 'classified_by_rule'
  | 'classified_by_ai'
  | 'classified_by_qc_agent'
  | 'classification_error';

export type QCOutcome = 'clean' | 'consolidated' | 'flagged' | 'skipped';

export interface QCProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
  /** Set after a supplier is processed — describes what action was taken. */
  outcome?: QCOutcome;
  /** The winning taxonomy path when outcome is 'consolidated'. */
  consolidatedTo?: string;
}

export interface ResearchProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}

export interface ClassificationProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}

export interface CategorySelectionInput {
  suppliers: Array<{ name: string; research: SupplierInfo | null; parentName: string | null }>;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
}

export interface L3ClassificationInput {
  categoryPath: string;
  l3Taxonomy: TaxonomyNode[];
  transactions: Array<Record<string, unknown>>;
  columnPriorities: string[];
  companyContext: CompanyContext;
  supplierName: string;
  supplierType: string | null;
}

export interface ClassificationInput {
  transactions: Array<Record<string, unknown>>;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
  supplierResearch: SupplierInfo | null;
  parentName?: string | null;
  columnPriorities: string[];
}

export interface ClassificationEntry {
  id: number;
  classificationPath: string;
}

export interface ClassificationResult {
  classifications: ClassificationEntry[];
  assignments: Record<string, number[]>;
}
