import type { TaxonomyNode } from './taxonomy';
import type { CompanyContext } from './project';
import type { SupplierInfo } from './suppliers';

export type ClassificationStatus =
  | 'unclassified'
  | 'classified_by_rule'
  | 'classified_by_ai'
  | 'classification_error';

export interface ResearchProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}

export interface ClassificationProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
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
