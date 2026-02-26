export interface CompanyContext {
  companyName?: string;
  industry?: string;
  sector?: string;
  description?: string;
  businessFocus?: string;
  procurementNuances?: string;
}

export interface ProjectMetadata {
  id: string;
  projectName: string;
  createdAt: string;
  companyContext: CompanyContext | null;
  taxonomyName: string | null;
  tailSpendThreshold: number;
  columnMapping: Record<string, unknown> | null;
}

export interface ProjectMetadataUpdate {
  companyContext?: CompanyContext;
  tailSpendThreshold?: number;
  taxonomyName?: string;
  columnMapping?: Record<string, unknown>;
}
