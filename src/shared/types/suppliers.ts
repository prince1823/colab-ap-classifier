import type { ConfidenceLevel } from './canonicalization';

export type SupplierType = 'company' | 'individual' | 'government';

export interface SupplierInfo {
  supplierType?: SupplierType;
  officialBusinessName?: string;
  description?: string;
  websiteUrl?: string;
  industry?: string;
  productsServices?: string;
  supplierAddress?: string;
  serviceType?: string;
  naicsCode?: string;
  naicsDescription?: string;
  sicCode?: string;
  primaryBusinessModel?: string;
  primaryRevenueStreams?: string;
  serviceCategories?: string;
  targetMarket?: string;
  confidence?: ConfidenceLevel;
  sources?: string[];
}

/**
 * SupplierResearchResult is SupplierInfo with required confidence and sources.
 */
export type SupplierResearchResult = SupplierInfo &
  Required<Pick<SupplierInfo, 'confidence' | 'sources'>>;

export interface ProjectSupplier {
  id: string;
  supplierName: string;
  aliases: string[] | null;
  parentSupplierId: string | null;
  parentName: string | null;
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
  parentName?: string | null;
  categoryA?: boolean;
  categoryATaxonomyNodeId?: string | null;
  supplierInfo?: SupplierInfo;
  aliases?: string[] | null;
}
