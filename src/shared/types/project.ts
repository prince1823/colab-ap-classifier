import type { CanonicalColumnMapping } from './canonicalization';

export interface CompanyContext {
  industry: string;
  sector?: string;
  description?: string;
  businessFocus?: string;
  procurementNuances?: string;
}

export interface ProjectMetadata {
  name: string;
  filePath: string;
  companyContext: CompanyContext | null;
  columnMappings: CanonicalColumnMapping | null;
  invoiceGroupingColumns: string[] | null;
  tailSpendThreshold: number;
  taxonomyName: string | null;
  createdAt: string | null;
}

export interface ProjectMetadataUpdate {
  companyContext?: CompanyContext;
  tailSpendThreshold?: number;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: string;
}
