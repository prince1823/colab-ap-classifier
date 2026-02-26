export interface SupplierInfo {
  supplierType?: string;
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
  confidence?: 'high' | 'medium' | 'low';
  sources?: string[];
}

/** A supplier from the shared supplier_universe.db */
export interface Supplier {
  id: string;
  supplierName: string;
  aliases: string[] | null;
  parentSupplierId: string | null;
  parentName: string | null;
  supplierInfo: SupplierInfo | null;
  categoryA: boolean;
  categoryATaxonomyNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A project supplier = derived from transactions + enriched from supplier_universe.db */
export interface ProjectSupplierView {
  supplierName: string;
  transactionCount: number;
  totalSpend: number;
  /** null if not yet researched (no row in supplier_universe.db) */
  supplierInfo: SupplierInfo | null;
  parentName: string | null;
  categoryA: boolean;
  categoryATaxonomyNodeId: string | null;
  isResearched: boolean;
}

export interface SupplierUpdateInput {
  parentSupplierId?: string | null;
  parentName?: string | null;
  categoryA?: boolean;
  categoryATaxonomyNodeId?: string | null;
  supplierInfo?: SupplierInfo;
  aliases?: string[] | null;
}
