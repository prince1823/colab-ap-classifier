import type { ConfidenceLevel } from './canonicalization';

export type SupplierType = 'company' | 'individual' | 'government';

export interface SupplierInfo {
  officialBusinessName?: string;
  description?: string;
  websiteUrl?: string;
  industry?: string;
  productsServices?: string;
  parentCompany?: string;
  supplierAddress?: string;
  serviceType?: string;
  naicsCode?: string;
  naicsDescription?: string;
  sicCode?: string;
  primaryBusinessModel?: string;
  primaryRevenueStreams?: string;
  serviceCategories?: string;
  targetMarket?: string;
}

export interface SupplierResearchResult extends SupplierInfo {
  confidence: ConfidenceLevel;
  sources: string[];
}

export interface ProjectSupplier {
  id: string;
  supplierName: string;
  parentSupplierId: string | null;
  supplierType: SupplierType | null;
  supplierInfo: SupplierInfo | null;
  categoryA: boolean;
  categoryATaxonomyNodeId: string | null;
  transactionCount: number;
  totalSpend: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierUpdateInput {
  parentSupplierId?: string | null;
  supplierType?: SupplierType | null;
  categoryA?: boolean;
  categoryATaxonomyNodeId?: string | null;
  supplierInfo?: SupplierInfo;
}
