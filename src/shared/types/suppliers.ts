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
  parentCompanyName?: string;
  confidence?: 'high' | 'medium' | 'low';
  sources?: string[];
}

export interface SupplierParent {
  id: string;
  name: string;
  createdAt: string;
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
  parentSupplierId: string | null;
  parentName: string | null;
  supplierInfo: SupplierInfo | null;
  mappedTaxonomyPaths: string[] | null;
  universeMatch: boolean;
  isResearched: boolean;
  createdAt: string;
}

export interface ProjectSupplierView extends ProjectSupplier {
  transactionCount: number;
  totalSpend: number;
  aliases: string[];
}

export interface SupplierUpdateInput {
  supplierInfo?: SupplierInfo;
  aliases?: string[] | null;
  mappedTaxonomyPaths?: string[] | null;
}

// ─── CSV Apply Types ────────────────────────────────────────────────────────

export interface CsvApplyRow {
  parentName: string | null;
  supplierName: string;
  aliases: string[];
}

export interface CsvApplyDiff {
  renames: Array<{ supplierId: string; oldName: string; newName: string }>;
  merges: Array<{ survivorId: string; survivorName: string; loserIds: string[]; loserNames: string[] }>;
  aliasReassignments: Array<{ alias: string; fromSupplierId: string; fromName: string; toSupplierId: string; toName: string }>;
  parentCreations: Array<{ name: string }>;
  parentRenames: Array<{ parentId: string; oldName: string; newName: string }>;
  parentMerges: Array<{ survivorId: string; survivorName: string; loserIds: string[]; loserNames: string[] }>;
  parentChanges: Array<{ supplierId: string; supplierName: string; oldParentName: string | null; newParentName: string | null }>;
  warnings: {
    unknownAliases: Array<{ alias: string; csvSupplierName: string }>;
    unmatchableRows: Array<{ supplierName: string; reason: string }>;
  };
}

export interface CsvApplyResult {
  applied: boolean;
  diff: CsvApplyDiff;
  noChanges: boolean;
}
