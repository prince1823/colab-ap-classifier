export interface CompanyContext {
  companyName?: string;
  industry?: string;
  sector?: string;
  description?: string;
  businessFocus?: string;
  procurementNuances?: string;
}

/**
 * Convenience view assembled from project_settings KV store.
 * Used by the renderer to display project state.
 */
export interface ProjectMetadata {
  id: string;
  projectName: string;
  filePath: string | null;
  createdAt: string;
  companyContext: CompanyContext | null;
  taxonomyName: string | null;
  tailSpendThreshold: number;
  columnMapping: Record<string, string> | null;
}

export interface ProjectMetadataUpdate {
  companyContext?: CompanyContext | null;
  taxonomyName?: string | null;
  tailSpendThreshold?: number;
  columnMapping?: Record<string, string> | null;
}
