import type {
  CanonicalizationResult,
  CanonicalColumnDefinition,
  ConfidenceLevel,
} from '../../shared/types/canonicalization';
import * as llmClient from '../services/llm-client';
import * as settingsService from '../services/settings';

/**
 * The 14 canonical columns used for AP classification.
 */
export const CANONICAL_COLUMNS: CanonicalColumnDefinition[] = [
  {
    name: 'supplier_name',
    relevance: 'critical',
    type: 'text',
    aliases: ['Vendor', 'Supplier', 'Company'],
    description: 'The name of the supplier or vendor',
  },
  {
    name: 'line_description',
    relevance: 'critical',
    type: 'log_text',
    aliases: ['Item', 'Description', 'Line Item'],
    description: 'Description of the line item',
  },
  {
    name: 'gl_description',
    relevance: 'high',
    type: 'log_text',
    aliases: ['GL', 'Account Description', 'Journal'],
    description: 'General ledger account description',
  },
  {
    name: 'spend_amount',
    relevance: 'critical',
    type: 'number',
    aliases: ['Amount', 'Cost', 'Price', 'Total'],
    description: 'The monetary amount of the transaction',
  },
  {
    name: 'gl_code',
    relevance: 'high',
    type: 'category',
    aliases: ['Account Code', 'GL Account'],
    description: 'General ledger account code',
  },
  {
    name: 'department',
    relevance: 'medium',
    type: 'category',
    aliases: ['Dept', 'Business Unit'],
    description: 'Department or business unit',
  },
  {
    name: 'invoice_date',
    relevance: 'high',
    type: 'date',
    aliases: ['Date', 'Invoice Date', 'Transaction Date'],
    description: 'Date of the invoice or transaction',
  },
  {
    name: 'creation_date',
    relevance: 'low',
    type: 'date',
    aliases: ['Created', 'Record Date'],
    description: 'Date the record was created',
  },
  {
    name: 'company',
    relevance: 'medium',
    type: 'category',
    aliases: ['Entity', 'Legal Entity'],
    description: 'The company or legal entity',
  },
  {
    name: 'cost_center',
    relevance: 'medium',
    type: 'category',
    aliases: ['Cost Center', 'Center'],
    description: 'Cost center identifier',
  },
  {
    name: 'po_number',
    relevance: 'low',
    type: 'text',
    aliases: ['PO', 'Purchase Order'],
    description: 'Purchase order number',
  },
  {
    name: 'supplier_address',
    relevance: 'low',
    type: 'text',
    aliases: ['Address', 'Supplier Address'],
    description: 'Address of the supplier',
  },
  {
    name: 'currency',
    relevance: 'low',
    type: 'category',
    aliases: ['Currency Code'],
    description: 'Currency code of the transaction',
  },
  {
    name: 'memo',
    relevance: 'low',
    type: 'log_text',
    aliases: ['Notes', 'Comments', 'Memo'],
    description: 'Additional notes or comments',
  },
];

const MAX_SAMPLE_ROWS = 5;

/**
 * Build the system prompt that describes canonical columns for the LLM.
 */
export function buildSystemPrompt(): string {
  const columnDescriptions = CANONICAL_COLUMNS.map(
    (col) =>
      `- **${col.name}** (type: ${col.type}, relevance: ${col.relevance}): ${col.description}. Common aliases: ${col.aliases.join(', ')}`
  ).join('\n');

  return `You are a data mapping assistant. Your task is to map CSV column headers to a set of canonical column names used for accounts payable classification.

## Canonical Columns

${columnDescriptions}

## Instructions

Given a list of CSV column headers and sample data rows, determine which CSV column best maps to each canonical column. Consider:

1. Column header names and their similarity to canonical names and aliases
2. The data type of sample values (numbers, dates, text, categories)
3. The actual content of sample values

## Response Format

You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON). Use this exact structure:

{
  "mappings": {
    "<canonical_column_name>": "<csv_column_name>",
    ...
  },
  "confidence": "high" | "medium" | "low",
  "unmappedClientColumns": ["<csv columns not mapped to any canonical column>"],
  "importantUnmappedColumns": ["<csv columns that seem important but have no canonical match>"],
  "unmappedCanonicalColumns": ["<canonical columns with no matching CSV column>"],
  "reasoning": "<brief explanation of mapping decisions>"
}

Rules:
- Only include a mapping if you are reasonably confident the CSV column matches the canonical column.
- Each CSV column can map to at most one canonical column.
- Each canonical column can map to at most one CSV column.
- Set confidence to "high" if most critical columns are mapped with high certainty, "medium" if there is some ambiguity, "low" if many mappings are uncertain.
- List any CSV columns that seem to contain important data but do not match any canonical column in importantUnmappedColumns.`;
}

/**
 * Build the user prompt containing CSV headers and sample data.
 */
export function buildUserPrompt(
  columns: string[],
  sampleData: Record<string, string>[]
): string {
  const rows = sampleData.slice(0, MAX_SAMPLE_ROWS);

  const sampleTable = rows
    .map((row, i) => {
      const values = columns
        .map((col) => `  ${col}: ${row[col] ?? '(empty)'}`)
        .join('\n');
      return `Row ${i + 1}:\n${values}`;
    })
    .join('\n\n');

  return `## CSV Column Headers

${columns.join(', ')}

## Sample Data (${rows.length} rows)

${sampleTable}

Please map these CSV columns to the canonical columns and respond with JSON only.`;
}

/**
 * Parse and validate the JSON response from the LLM into a CanonicalizationResult.
 */
export function parseResponse(responseText: string): CanonicalizationResult {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    // Remove opening fence (with optional language tag)
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
    // Remove closing fence
    cleaned = cleaned.replace(/\n?```\s*$/, '');
    cleaned = cleaned.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Failed to parse LLM response as JSON: ${cleaned.substring(0, 200)}`
    );
  }

  const data = parsed as Record<string, unknown>;

  // Validate required fields
  if (!data.mappings || typeof data.mappings !== 'object') {
    throw new Error('LLM response missing "mappings" object');
  }

  const validConfidenceLevels: ConfidenceLevel[] = ['high', 'medium', 'low'];
  const confidence = validConfidenceLevels.includes(
    data.confidence as ConfidenceLevel
  )
    ? (data.confidence as ConfidenceLevel)
    : 'low';

  const canonicalNames = new Set(CANONICAL_COLUMNS.map((c) => c.name));
  const rawMappings = data.mappings as Record<string, unknown>;
  const mappings: Record<string, string> = {};

  // Count how many keys are canonical names vs how many values are canonical names
  // to detect whether the LLM returned canonical→CSV or CSV→canonical orientation.
  let keysAreCanonical = 0;
  let valuesAreCanonical = 0;
  for (const [key, value] of Object.entries(rawMappings)) {
    if (canonicalNames.has(key)) keysAreCanonical++;
    if (typeof value === 'string' && canonicalNames.has(value)) valuesAreCanonical++;
  }

  const inverted = valuesAreCanonical > keysAreCanonical;

  for (const [key, value] of Object.entries(rawMappings)) {
    if (typeof value !== 'string' || value.length === 0) continue;

    if (inverted) {
      // LLM returned { csvColumn: canonicalName } — flip to canonical→CSV
      if (canonicalNames.has(value)) {
        mappings[value] = key;
      }
    } else {
      // Expected orientation: { canonicalName: csvColumn }
      if (canonicalNames.has(key)) {
        mappings[key] = value;
      }
    }
  }

  const toStringArray = (val: unknown): string[] => {
    if (Array.isArray(val)) {
      return val.filter((item): item is string => typeof item === 'string');
    }
    return [];
  };

  return {
    mappings,
    confidence,
    unmappedClientColumns: toStringArray(data.unmappedClientColumns),
    importantUnmappedColumns: toStringArray(data.importantUnmappedColumns),
    unmappedCanonicalColumns: toStringArray(data.unmappedCanonicalColumns),
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
  };
}

/**
 * Use an LLM to suggest mappings from CSV columns to canonical columns.
 *
 * @param columns - Array of CSV column header names
 * @param sampleData - Array of sample row objects (column name -> value)
 * @returns A CanonicalizationResult with suggested mappings
 */
export async function suggestMappings(
  columns: string[],
  sampleData: Record<string, string>[]
): Promise<CanonicalizationResult> {
  if (columns.length === 0) {
    return {
      mappings: {},
      confidence: 'low',
      unmappedClientColumns: [],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: CANONICAL_COLUMNS.map((c) => c.name),
      reasoning: 'No columns provided.',
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(columns, sampleData);

  // Use model from settings (configured via .env or runtime)
  const settings = settingsService.getSettings();
  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    model: settings.model,
    temperature: 0,
    maxTokens: 4096,
  });

  return parseResponse(responseText);
}
