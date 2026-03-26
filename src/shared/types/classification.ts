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

export interface FilterConditionQC {
  field: string;
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'is_true' | 'is_false' | 'contains';
  value?: string | number | boolean;
}

export interface QCConfig {
  scope: FilterConditionQC[];
  algorithmic: {
    enabled: boolean;
    l3Threshold: number;
    l2Threshold: number;
  };
  llm: {
    enabled: boolean;
    gateConditions: FilterConditionQC[];
    rules: string;
  };
}

export interface QCResult {
  recommendations: Array<{
    groupNumbers: number[];
    toClassificationPath: string;
    reason: string;
  }>;
  noChangeNeeded: boolean;
}

export interface SpendByTaxonomyResult {
  taxonomyNodeId: string;
  fullPath: string;
  l1: string;
  l2: string;
  spend: number;
  txnCount: number;
}

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

export interface IngestProgress {
  status: 'running' | 'completed' | 'failed';
  totalRows: number;
  processedRows: number;
  percentage: number;
  currentStep: string;
  result?: { rowsInserted: number; uploadId: string };
  error?: string;
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

export interface TailSpendCategorySelectionInput {
  suppliers: Array<{
    name: string;
    groups: Array<{ fields: Array<[string, string]>; count: number }>;
  }>;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
}

export interface TailSpendL3Input {
  categoryPath: string;
  l3Taxonomy: TaxonomyNode[];
  suppliers: Array<{
    name: string;
    groups: Array<{ fields: Array<[string, string]>; count: number }>;
  }>;
  companyContext: CompanyContext;
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
