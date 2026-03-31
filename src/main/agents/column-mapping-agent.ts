import type {
  ColumnMappingResult,
  ConfidenceLevel,
} from '../../shared/types/column-mapping';
import { CANONICAL_COLUMNS } from '../../shared/canonical-columns';
import type { ColumnMappingAgent, LLMClient } from '../../shared/types/services';
import * as llmClient from '../services/llm-client';
import { traceLog } from '../utils/llm-trace';

const MAX_SAMPLE_ROWS = 5;

/**
 * Build the system prompt that describes canonical columns for the LLM.
 */
export function buildSystemPrompt(): string {
  const columnDescriptions = CANONICAL_COLUMNS.map(
    (col) =>
      `- **${col.name}** (type: ${col.type}): ${col.description}. Common aliases: ${col.aliases.join(', ')}`
  ).join('\n');

  return `You are a data mapping assistant. Map client data columns to canonical columns for spend classification.

CONTEXT: This agent runs automatically when a CSV is previewed. It suggests mappings from
CSV columns to canonical names using column headers and sample values. The user reviews,
edits, and approves the suggested mappings.

CRITICAL: Map ALL available fields matching canonical columns. Missing fields break downstream classification.

## Canonical Columns

${columnDescriptions}

## Mapping Strategy
1. Map supplier_name, spend_amount, and master_date first — these are required
2. Map all other canonical columns if a matching CSV column is available
3. Skip ONLY system/metadata fields (mapping rules, flags, audit fields, derived indicators)

## Primary Date Field (Required)
- master_date — CRITICAL. Map the most authoritative date column here (invoice date, transaction date, PO date, etc.). This drives all time-based analysis.
- company (Company, Legal Entity) — Important for invoice grouping
- creation_date (Creation Date) — Important for accurate invoice grouping

## Address Field Mapping
- Map ONE primary address field to supplier_address (prefer complete addresses over components)
- If only address components exist (Address 1, City, State, etc.), map the most complete field
- DO NOT map multiple fields to the same canonical column

## Instructions

Given CSV column headers and sample data rows, determine which CSV column best maps to each canonical column. Consider:
1. Column header names and their similarity to canonical names and aliases
2. The data type of sample values (numbers, dates, text, categories)
3. The actual content of sample values

IMPORTANT: If a client column matches canonical (by name/alias), MAP IT. Better to over-map than under-map.

## Mapping Rules
Map: ALL matching fields (especially Critical/High/Medium)
Skip: "Mapping Rule", "Flag", system IDs, audit fields, derived indicators

## Mapping Orientation
Output mappings as {canonical_name: csv_column_name}.

## Response Format

You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON). Use this exact structure:

{
  "mappings": {
    "<canonical_column_name>": "<csv_column_name>",
    ...
  },
  "confidence": "high" | "medium" | "low",
  "unmappedClientColumns": ["<csv columns not mapped to any canonical column>"],
  "importantUnmappedColumns": ["<csv columns with useful info for classification but no canonical match (e.g., project codes, cost centers, department codes, region/territory info, custom classification fields)>"],
  "unmappedCanonicalColumns": ["<canonical columns with no matching CSV column>"],
  "reasoning": "<brief explanation of mapping decisions>"
}

Rules:
- Only include a mapping if you are reasonably confident the CSV column matches the canonical column.
- Each CSV column can map to at most one canonical column.
- Each canonical column can map to at most one CSV column.
- Set confidence to "high" if most critical columns are mapped with high certainty, "medium" if there is some ambiguity, "low" if many mappings are uncertain.
- importantUnmappedColumns: columns with potentially useful info for classification even if no canonical match (project codes, cost centers, transaction categories, department codes, region/territory info, custom classification fields). Exclude system/metadata fields.`;
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
 * Parse and validate the JSON response from the LLM into a ColumnMappingResult.
 */
export function parseResponse(responseText: string): ColumnMappingResult {
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
      // First-wins: ignore later entries that would overwrite an already-mapped canonical
      if (canonicalNames.has(value) && !(value in mappings)) {
        mappings[value] = key;
      }
    } else {
      // Expected orientation: { canonicalName: csvColumn }
      // First-wins: ignore later entries that would overwrite an already-mapped canonical
      if (canonicalNames.has(key) && !(key in mappings)) {
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
 * @returns A ColumnMappingResult with suggested mappings
 */
export async function suggestMappings(
  columns: string[],
  sampleData: Record<string, string>[]
): Promise<ColumnMappingResult> {
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

  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    temperature: 0,
    maxTokens: 1024,
  });

  return parseResponse(responseText);
}

/**
 * DI-compatible column mapping agent class.
 */
export class LLMColumnMappingAgent implements ColumnMappingAgent {
  constructor(private llm: LLMClient) {}

  async suggestMappings(
    columns: string[],
    sampleRows: Record<string, string>[]
  ): Promise<ColumnMappingResult> {
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
    const userPrompt = buildUserPrompt(columns, sampleRows);

    const start = Date.now();
    let responseText: string;
    try {
      responseText = await this.llm.chat(systemPrompt, userPrompt, {
        temperature: 0,
        maxTokens: 1024,
      });
    } catch (err) {
      traceLog({
        timestamp: new Date().toISOString(),
        agent: 'column-mapping',
        model: 'default',
        systemPrompt,
        userPrompt,
        response: '',
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const elapsedMs = Date.now() - start;

    let parsed: import('../../shared/types/column-mapping').ColumnMappingResult;
    try {
      parsed = parseResponse(responseText);
    } catch (err) {
      traceLog({
        timestamp: new Date().toISOString(),
        agent: 'column-mapping',
        model: 'default',
        systemPrompt,
        userPrompt,
        response: responseText,
        elapsedMs,
        error: `parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'column-mapping',
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    return parsed;
  }
}
