export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CanonicalColumnRelevance = 'critical' | 'high' | 'medium' | 'low';
export type CanonicalColumnType = 'text' | 'log_text' | 'number' | 'category' | 'date';

// Maps canonical column name → original CSV column name
export interface CanonicalColumnMapping {
  [canonicalName: string]: string;
}

export interface CanonicalColumnDefinition {
  name: string;
  relevance: CanonicalColumnRelevance;
  type: CanonicalColumnType;
  aliases: string[];
  description: string;
}

export interface CSVPreview {
  columns: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
}

export interface CanonicalizationResult {
  mappings: CanonicalColumnMapping;
  confidence: ConfidenceLevel;
  unmappedClientColumns: string[];
  importantUnmappedColumns: string[];
  unmappedCanonicalColumns: string[];
  reasoning: string;
}
