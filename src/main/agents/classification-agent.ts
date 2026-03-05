import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { CompanyContext } from '../../shared/types/project';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type { ClassificationInput, ClassificationResult } from '../../shared/types/classification';
import type { ClassificationAgent, LLMClient } from '../../shared/types/services';
import * as llmClient from '../services/llm-client';

// Re-export from shared types for backward compatibility
export type { ClassificationInput, ClassificationResult };

/**
 * Build the system prompt for the classification agent.
 */
export function buildSystemPrompt(): string {
  return `You are an AP transaction classifier. Classify business transactions into taxonomy categories using contextual reasoning.

## Critical Classification Rules (Check These First)

1. MINIMUM DEPTH RULE:
   - NEVER return just L1 or L1|L2 — must return L1|L2|L3 (exactly 3 levels)

2. SUPPLIER TYPE AS SIGNAL:
   - Government supplierType is a STRONG signal for Exempt classification, but NOT a hard rule
   - EXCEPTION: Government utility payments (electricity, water, gas) should be classified
     under the appropriate Utilities category, NOT Exempt
   - Use supplierType as one signal among many — evaluate contextually

3. INTERCOMPANY SPEND:
   - Check if the supplier appears to be a subsidiary of the client company (from company_context)
   - If the supplier is a subsidiary/affiliate of the client → classify under Exempt

## Taxonomy Descriptions and Company Context

The taxonomy includes paths WITH descriptions (when available).

YOU MUST:
1. READ taxonomy descriptions carefully — they define what each category includes/excludes
2. USE company_context to understand the business domain and inform your decisions
3. MATCH transactions to category definitions in descriptions, not just keywords
4. REFERENCE descriptions when distinguishing between similar categories

Taxonomy descriptions are AUTHORITATIVE — they define category boundaries.

## Signal Prioritization

- Transaction fields are listed in priority order (most important first). Weight earlier fields more heavily in your classification decision.
- Supplier research info (type, offerings, website, industry) provides strong context about what the supplier does.
- Taxonomy descriptions (when available) > Generic keyword matching
- Specific, detailed information > Generic, vague information (regardless of field type)
- Company context helps interpret signals in domain-specific ways

## Process

1. REVIEW COMPANY CONTEXT:
   a. Read the company_context provided — it describes the business domain
   b. Use industry/sector/business_focus/procurement_nuances to understand operational priorities
   c. Use it to understand domain-specific terminology

2. EXAMINE TAXONOMY PATHS WITH DESCRIPTIONS:
   a. Start from deepest taxonomy levels (L3)
   b. READ the Description field for each candidate path (if provided)
   c. Match transaction context to what the description says the category includes
   d. Use similarity scores as one signal, but descriptions are authoritative

3. MATCH TRANSACTION TO TAXONOMY:
   a. Use the transaction fields in the order provided (higher-priority fields first)
   b. If multiple categories seem similar, choose the one whose description best matches

## Edge Cases
- Zero or very small amounts: Evaluate if this is an adjustment, refund, or actual purchase
- Missing/blank fields: Rely on higher-priority fields first
- Supplier profile mismatch: If supplier typically provides X but transaction suggests Y,
  evaluate contextually using all available signals

## General Rules
- Prefer specific categories over "Other" when confident
- Distinguish consumption expenses (meals, services consumed) from operational purchases

## Response Format
You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON):
{
  "classificationPath": "L1|L2|L3",
  "reasoning": "<concise explanation (2-3 sentences): key signals and why this category was chosen>",
  "descriptionSupplierAligned": true/false
}

The descriptionSupplierAligned field should be true if the transaction description and supplier research point to the same classification, false if they conflict or if no supplier research is available.`;
}

/**
 * Format taxonomy nodes into a readable tree for the prompt.
 */
export function formatTaxonomyTree(taxonomy: TaxonomyNode[]): string {
  if (taxonomy.length === 0) {
    return '(No taxonomy provided)';
  }

  const lines: string[] = [];
  for (const node of taxonomy) {
    if (node.depth === 3) {
      const desc = node.description ? ` - ${node.description}` : '';
      lines.push(`  ${node.fullPath}${desc}`);
    }
  }

  if (lines.length === 0) {
    // Fallback: show all nodes if none are depth 3
    for (const node of taxonomy) {
      const desc = node.description ? ` - ${node.description}` : '';
      lines.push(`  ${node.fullPath}${desc}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format supplier research into a readable block for the prompt.
 */
export function formatSupplierResearch(supplier: SupplierInfo | null, parentName?: string | null): string {
  if (!supplier) {
    return '(No supplier research available)';
  }

  const parts: string[] = [];
  if (supplier.supplierType) parts.push(`Supplier Type: ${supplier.supplierType}`);
  if (supplier.officialBusinessName) parts.push(`Business Name: ${supplier.officialBusinessName}`);
  if (supplier.description) parts.push(`Description: ${supplier.description}`);
  if (supplier.industry) parts.push(`Industry: ${supplier.industry}`);
  if (supplier.productsServices) parts.push(`Products/Services: ${supplier.productsServices}`);
  if (parentName) parts.push(`Parent Company: ${parentName}`);
  if (supplier.serviceType) parts.push(`Service Type: ${supplier.serviceType}`);
  if (supplier.naicsCode) parts.push(`NAICS Code: ${supplier.naicsCode}`);
  if (supplier.naicsDescription) parts.push(`NAICS Description: ${supplier.naicsDescription}`);
  if (supplier.primaryBusinessModel) parts.push(`Business Model: ${supplier.primaryBusinessModel}`);
  if (supplier.serviceCategories) parts.push(`Service Categories: ${supplier.serviceCategories}`);
  if (supplier.targetMarket) parts.push(`Target Market: ${supplier.targetMarket}`);
  if (supplier.websiteUrl) parts.push(`Website: ${supplier.websiteUrl}`);

  return parts.length > 0 ? parts.join('\n') : '(No supplier research available)';
}

/**
 * Format historical classifications into a readable block for the prompt.
 */
export function formatHistoricalClassifications(
  classifications: { l1: string; l2: string; l3: string; count: number }[]
): string {
  if (classifications.length === 0) {
    return '(No historical classifications available)';
  }

  return classifications
    .map((c) => `  ${c.l1}|${c.l2}|${c.l3} (used ${c.count} time${c.count !== 1 ? 's' : ''})`)
    .join('\n');
}

/** System/metadata columns to exclude from LLM prompts — not useful for classification. */
const EXCLUDED_FIELDS = new Set([
  'id',
  'row_index',
  'created_at',
  'updated_at',
  'taxonomy_node_id',
  'classification_reasoning',
  'classification_status',
]);

/**
 * Extract the display fields for a transaction row based on column priorities.
 * Returns an array of [key, stringValue] pairs.
 */
function extractFields(
  txn: Record<string, unknown>,
  columnPriorities?: string[]
): Array<[string, string]> {
  if (columnPriorities && columnPriorities.length > 0) {
    return columnPriorities
      .filter((k) => !EXCLUDED_FIELDS.has(k))
      .filter((k) => txn[k] !== null && txn[k] !== undefined && txn[k] !== '')
      .map((k) => [k, String(txn[k])] as [string, string]);
  }
  return Object.entries(txn)
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !EXCLUDED_FIELDS.has(k))
    .map(([k, v]) => [k, String(v)] as [string, string]);
}

/**
 * Format transaction details into a readable block for the prompt.
 * When columnPriorities is provided, rows are deduplicated by their priority column values
 * and grouped with a count. Otherwise falls back to all columns, no dedup.
 */
export function formatTransactions(
  transactions: Array<Record<string, unknown>>,
  columnPriorities?: string[]
): string {
  if (transactions.length === 0) {
    return '(No transactions provided)';
  }

  // Deduplicate when column priorities are set
  if (columnPriorities && columnPriorities.length > 0) {
    const groups = new Map<string, { fields: Array<[string, string]>; count: number }>();

    for (const txn of transactions) {
      const fields = extractFields(txn, columnPriorities);
      const key = JSON.stringify(fields);
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { fields, count: 1 });
      }
    }

    let groupIdx = 0;
    const parts: string[] = [];
    for (const { fields, count } of groups.values()) {
      groupIdx++;
      const label = count === 1 ? '1 row' : `${count} rows`;
      const fieldStr = fields.map(([k, v]) => `  ${k}: ${v}`).join('\n');
      parts.push(`Group ${groupIdx} (${label}):\n${fieldStr}`);
    }
    return parts.join('\n\n');
  }

  // No priorities: send all columns, no dedup
  return transactions
    .map((txn, i) => {
      const fields = extractFields(txn)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      return `Transaction ${i + 1}:\n${fields}`;
    })
    .join('\n\n');
}

/**
 * Build the user prompt with all classification context.
 */
export function buildUserPrompt(input: ClassificationInput): string {
  const { taxonomy, companyContext, supplierResearch, parentName, historicalClassifications, transactions, columnPriorities } = input;

  const contextParts: string[] = [];
  contextParts.push(`Industry: ${companyContext.industry}`);
  if (companyContext.sector) contextParts.push(`Sector: ${companyContext.sector}`);
  if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
  if (companyContext.businessFocus) contextParts.push(`Business Focus: ${companyContext.businessFocus}`);
  if (companyContext.procurementNuances) contextParts.push(`Procurement Nuances: ${companyContext.procurementNuances}`);

  const columnPriorityNote = columnPriorities && columnPriorities.length > 0
    ? '\nTransaction fields are listed in order of classification priority (most important first). Identical rows are grouped with a count.\n'
    : '';

  return `## Taxonomy
${formatTaxonomyTree(taxonomy)}

## Company Context
${contextParts.join('\n')}

## Supplier Research
${formatSupplierResearch(supplierResearch, parentName)}

## Historical Classifications
${formatHistoricalClassifications(historicalClassifications)}

## Transactions
${columnPriorityNote}${formatTransactions(transactions, columnPriorities)}

Classify the above transactions into the taxonomy. Respond with JSON only.`;
}

/**
 * Parse the LLM response text into a ClassificationResult.
 */
export function parseResponse(responseText: string): ClassificationResult {
  let cleaned = responseText.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
    cleaned = cleaned.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned.substring(0, 200)}`);
  }

  // Handle array, object, and { transactions: [...] } wrapper responses from LLM
  let data: Record<string, unknown>;
  if (Array.isArray(parsed)) {
    // If LLM returned an array, take the first element
    if (parsed.length === 0) {
      throw new Error('LLM response is an empty array');
    }
    data = parsed[0] as Record<string, unknown>;
  } else {
    data = parsed as Record<string, unknown>;
  }

  // Unwrap { "transactions": [...] } envelope — some LLMs wrap per-transaction
  // results in an array even when we ask for a single classification.
  if (
    Array.isArray(data.transactions) &&
    data.transactions.length > 0 &&
    !data.classificationPath &&
    !data.classification_path
  ) {
    data = data.transactions[0] as Record<string, unknown>;
  }

  // Unwrap single-element arrays — some LLMs return classificationPath as
  // ["Non Clinical|Telecom|Telecom"] instead of a plain string.
  for (const key of ['classificationPath', 'classification_path', 'path', 'taxonomyPath', 'taxonomy_path']) {
    const val = data[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
      data[key] = val[0];
    }
  }

  // Try multiple field name variations for classification path
  const classificationPath =
    (typeof data.classificationPath === 'string' && data.classificationPath) ||
    (typeof data.classification_path === 'string' && data.classification_path) ||
    (typeof data.path === 'string' && data.path) ||
    (typeof data.taxonomyPath === 'string' && data.taxonomyPath) ||
    (typeof data.taxonomy_path === 'string' && data.taxonomy_path) ||
    '';

  if (!classificationPath) {
    // Provide helpful error with available fields
    const availableFields = Object.keys(data).join(', ');
    throw new Error(
      `LLM response missing classification path field. ` +
      `Expected "classificationPath" but got fields: ${availableFields}. ` +
      `Response preview: ${JSON.stringify(data).substring(0, 200)}`
    );
  }

  return {
    classificationPath,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
    descriptionSupplierAligned:
      typeof data.descriptionSupplierAligned === 'boolean'
        ? data.descriptionSupplierAligned
        : (typeof data.description_supplier_aligned === 'boolean'
          ? data.description_supplier_aligned
          : false),
  };
}

/**
 * Validate that L1 exists in the taxonomy.
 * Returns the corrected path if a case-insensitive match is found in taxonomy L1 values.
 */
export function validateL1(classificationPath: string, taxonomy: TaxonomyNode[]): string | null {
  const parts = classificationPath.split('|');
  if (parts.length === 0) return null;

  const l1 = parts[0];

  // Get all unique L1 values from taxonomy
  const taxonomyL1Values = [...new Set(taxonomy.map(node => node.l1))];

  // Exact match
  if (taxonomyL1Values.includes(l1)) {
    return classificationPath;
  }

  // Try case-insensitive match
  const matched = taxonomyL1Values.find(
    (v) => v.toLowerCase() === l1.toLowerCase()
  );
  if (matched) {
    parts[0] = matched;
    return parts.join('|');
  }

  return null;
}

/**
 * Validate that the classification path has exactly depth 3 (L1|L2|L3).
 * Returns the path if valid, adjusts if possible, or null if it cannot be fixed.
 */
export function validateDepth(classificationPath: string): string | null {
  const parts = classificationPath.split('|').filter((p) => p.trim().length > 0);

  if (parts.length === 3) {
    return parts.join('|');
  }

  if (parts.length > 3) {
    // Truncate to depth 3
    return parts.slice(0, 3).join('|');
  }

  // Depth < 3 - cannot fix automatically
  return null;
}

/**
 * Find the closest matching taxonomy path for a given classification path.
 * Returns the matched taxonomy node's fullPath, or the original path if no match is found.
 */
export function findClosestTaxonomyMatch(
  classificationPath: string,
  taxonomy: TaxonomyNode[]
): string {
  // Exact match
  const exactMatch = taxonomy.find(
    (node) => node.fullPath === classificationPath
  );
  if (exactMatch) {
    return exactMatch.fullPath;
  }

  // Case-insensitive exact match
  const lowerPath = classificationPath.toLowerCase();
  const caseMatch = taxonomy.find(
    (node) => node.fullPath.toLowerCase() === lowerPath
  );
  if (caseMatch) {
    return caseMatch.fullPath;
  }

  // Try matching L1|L2 and finding any L3 under it
  const parts = classificationPath.split('|');
  if (parts.length >= 2) {
    const l1l2 = `${parts[0]}|${parts[1]}`.toLowerCase();
    const partialMatch = taxonomy.find(
      (node) =>
        node.depth === 3 &&
        node.fullPath.toLowerCase().startsWith(l1l2)
    );
    if (partialMatch) {
      return partialMatch.fullPath;
    }
  }

  // Try matching just L1 and finding any depth-3 node under it
  if (parts.length >= 1) {
    const l1 = parts[0].toLowerCase();
    const l1Match = taxonomy.find(
      (node) =>
        node.depth === 3 &&
        node.fullPath.toLowerCase().startsWith(l1 + '|')
    );
    if (l1Match) {
      return l1Match.fullPath;
    }
  }

  // No match found, return original
  return classificationPath;
}

/**
 * Validate and post-process a classification result against the taxonomy.
 */
export function validateClassification(
  result: ClassificationResult,
  taxonomy: TaxonomyNode[]
): ClassificationResult {
  let path = result.classificationPath;

  // Validate L1
  const validatedL1 = validateL1(path, taxonomy);
  if (validatedL1 === null) {
    // L1 is unrecognizable - attempt to find a taxonomy match
    const closestMatch = findClosestTaxonomyMatch(path, taxonomy);
    if (closestMatch !== path) {
      path = closestMatch;
    } else {
      // Cannot fix L1; keep what we have and let depth validation handle it
      const parts = path.split('|');
      if (parts.length > 0 && taxonomy.length > 0) {
        // Default to first L1 in taxonomy if L1 is invalid
        parts[0] = taxonomy[0].l1;
        path = parts.join('|');
      }
    }
  } else {
    path = validatedL1;
  }

  // Validate depth
  const validatedDepth = validateDepth(path);
  if (validatedDepth === null) {
    // Depth < 3 - attempt to find a taxonomy match to fill in
    const closestMatch = findClosestTaxonomyMatch(path, taxonomy);
    const matchParts = closestMatch.split('|');
    if (matchParts.length >= 3) {
      path = matchParts.slice(0, 3).join('|');
    } else {
      // Cannot recover depth; keep what we have and pad with "Uncategorized"
      const parts = path.split('|').filter((p) => p.trim().length > 0);
      while (parts.length < 3) {
        parts.push('Uncategorized');
      }
      path = parts.join('|');
    }
  } else {
    path = validatedDepth;
  }

  // Validate path exists in taxonomy
  if (taxonomy.length > 0) {
    path = findClosestTaxonomyMatch(path, taxonomy);
  }

  return {
    classificationPath: path,
    reasoning: result.reasoning,
    descriptionSupplierAligned: result.descriptionSupplierAligned,
  };
}

/**
 * Classify an invoice group using the LLM (standalone function — backward compat).
 */
export async function classifyInvoiceGroup(
  input: ClassificationInput
): Promise<ClassificationResult> {
  const { taxonomy } = input;

  if (input.transactions.length === 0) {
    return {
      classificationPath: 'Indirect|Uncategorized|Uncategorized',
      reasoning: 'No transactions provided for classification.',
      descriptionSupplierAligned: false,
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    temperature: 0,
    maxTokens: 512,
  });

  const rawResult = parseResponse(responseText);
  return validateClassification(rawResult, taxonomy);
}

/**
 * DI-compatible classification agent class.
 */
export class LLMClassificationAgent implements ClassificationAgent {
  constructor(private llm: LLMClient) {}

  async classifyInvoiceGroup(input: ClassificationInput): Promise<ClassificationResult> {
    const { taxonomy } = input;

    if (input.transactions.length === 0) {
      return {
        classificationPath: 'Indirect|Uncategorized|Uncategorized',
        reasoning: 'No transactions provided for classification.',
        descriptionSupplierAligned: false,
      };
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input);

    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 512,
    });

    const rawResult = parseResponse(responseText);
    return validateClassification(rawResult, taxonomy);
  }
}
