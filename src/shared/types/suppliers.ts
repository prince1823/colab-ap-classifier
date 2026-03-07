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
  mappedTaxonomyPaths: string[] | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Project Suppliers (per-project, FK-based model) ─────────────────────────

export type SupplierConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'merged';

export type SupplierType = 'company' | 'individual' | 'government';

export interface ProjectSupplier {
  id: string;
  supplierName: string;
  confirmationStatus: SupplierConfirmationStatus;
  isTailSpend: boolean;
  parentSupplierName: string | null;
  parentName: string | null;
  supplierInfo: SupplierInfo | null;
  mappedTaxonomyPaths: string[] | null;
  dataSource: 'universe' | 'web_search' | 'manual';
  universeMatch: boolean;
  createdAt: string;
}

export interface ProjectSupplierView extends ProjectSupplier {
  transactionCount: number;
  totalSpend: number;
  aliases: string[];
}

export interface SupplierUpdateInput {
  parentSupplierId?: string | null;
  parentName?: string | null;
  supplierInfo?: SupplierInfo;
  aliases?: string[] | null;
  mappedTaxonomyPaths?: string[] | null;
}
