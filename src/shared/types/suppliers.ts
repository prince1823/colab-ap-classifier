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

// ─── Supplier Universe Record ────────────────────────────────────────────────

/** Full supplier record from the shared supplier universe. */
export interface SupplierRecord {
  supplierInfo: SupplierInfo;
  aliases: string[];
  parentName: string | null;
  mappedTaxonomyPaths: string[];
  categoryASupplier: boolean;
}

/** Partial input for upserting a supplier into the universe. */
export interface SupplierRecordInput {
  supplierInfo?: Partial<SupplierInfo>;
  aliases?: string[];
  parentName?: string | null;
  mappedTaxonomyPaths?: string[];
  categoryASupplier?: boolean;
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
  l1L2Path: string[] | null;
  universeMatch: boolean;
  isResearched: boolean;
  categoryASupplier: boolean;
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
  l1L2Path?: string[];
  markResearched?: boolean;
  categoryASupplier?: boolean;
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
    missingAliases: Array<{ alias: string; supplierName: string }>;
  };
}

export interface CsvApplyResult {
  applied: boolean;
  diff: CsvApplyDiff;
  noChanges: boolean;
}
