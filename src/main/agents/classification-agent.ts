import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type { ClassificationInput, ClassificationResult, ClassificationEntry } from '../../shared/types/classification';
import type { ClassificationAgent, LLMClient } from '../../shared/types/services';
import { extractFields, buildDedupGroups } from '../utils/dedup-groups';
import { traceLog } from '../utils/llm-trace';

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

4. TAX AND ADJUSTMENT LINES:
   - Lines whose account description indicates a tax accrual or tax payment (e.g. "accrued state sales tax", "sales and use tax", "acc county sales tax", "use tax accrual") should be classified as non-sourceable tax spend only when the supplier is a government entity or tax authority
   - For non-government suppliers, these lines are accounting entries — classify them with the supplier's primary spend category, do NOT split them out

## Taxonomy Descriptions and Company Context

The taxonomy includes paths WITH descriptions (when available).

YOU MUST:
1. READ taxonomy descriptions carefully — they define what each category includes/excludes
2. USE company_context to understand the business domain and inform your decisions
3. MATCH transactions to category definitions in descriptions, not just keywords
4. REFERENCE descriptions when distinguishing between similar categories

Taxonomy descriptions are AUTHORITATIVE — they define category boundaries.

## Signal Prioritization

- **Supplier name + supplier research is the primary signal.** What the supplier is, what they sell, and what industry they're in should anchor your classification. GL account descriptions and codes are secondary — they reflect how an accountant labeled the entry, not what was actually purchased.
- Transaction fields are listed in priority order (most important first). The supplier name field will appear first when available — weight it heavily.
- Taxonomy descriptions (when available) are authoritative over keyword matching
- Company context helps interpret signals in domain-specific ways

## Process

1. REVIEW COMPANY CONTEXT:
   a. Read the company_context provided — it describes the business domain
   b. Use industry/description/sister_companies/additional_details to understand operational priorities
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
Respond with valid JSON only. No markdown fencing, no text outside the JSON.

{
  "classifications": [
    { "id": 1, "classificationPath": "L1|L2|L3" },
    { "id": 2, "classificationPath": "L1|L2|L3" }
  ],
  "assignments": {
    "1": [1, 2, 3],
    "2": [4, 5]
  }
}

Rules:
- Each classification has a unique integer id and a pipe-delimited taxonomy path at depth 3
- "assignments" maps each classification id to the Group numbers it applies to
- Every Group number from the Transactions section must appear in exactly one assignment entry
- Prefer a SINGLE classification when the supplier operates in one domain. Use multiple only when groups clearly belong to different taxonomy categories
- Do NOT include "reasoning" or any fields other than "classifications" and "assignments"`;
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
    const result = buildDedupGroups(transactions, columnPriorities);
    return result.promptText;
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
  const { taxonomy, companyContext, supplierResearch, parentName, transactions, columnPriorities } = input;

  const contextParts: string[] = [];
  contextParts.push(`Industry: ${companyContext.industry}`);
  if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
  if (companyContext.sisterCompanies) contextParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
  if (companyContext.additionalDetails) contextParts.push(`Additional Details: ${companyContext.additionalDetails}`);

  const columnPriorityNote = columnPriorities && columnPriorities.length > 0
    ? '\nTransaction fields are listed in order of classification priority (most important first). Identical rows are grouped with a count.\n'
    : '';

  return `## Taxonomy
${formatTaxonomyTree(taxonomy)}

## Company Context
${contextParts.join('\n')}

## Supplier Research
${formatSupplierResearch(supplierResearch, parentName)}

## Transactions
${columnPriorityNote}${formatTransactions(transactions, columnPriorities)}

Classify the above transactions into the taxonomy. Respond with JSON only.`;
}

/**
 * Parse the LLM response text into a ClassificationResult.
 */
export function parseResponse(responseText: string): ClassificationResult {
  // 1. Strip markdown code fences if present
  let cleaned = responseText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // 2. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse classification response as JSON: ${cleaned.slice(0, 200)}`);
  }

  // 3. Handle wrapper objects (e.g., {"result": {...}})
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (!obj.classifications && obj.result && typeof obj.result === 'object') {
      parsed = obj.result;
    }
  }

  const result = parsed as Record<string, unknown>;

  // 4. Validate classifications array
  if (!Array.isArray(result.classifications)) {
    throw new Error(`Expected "classifications" array in response, got: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const classifications: ClassificationEntry[] = result.classifications.map((c: any, i: number) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`Classification entry ${i} is not an object`);
    }
    let path = c.classificationPath ?? c.classification_path ?? c.path;
    // Handle single-element array quirk
    if (Array.isArray(path) && path.length === 1) path = path[0];
    if (typeof path !== 'string' || !path) {
      throw new Error(`Classification entry ${i} missing classificationPath`);
    }
    return { id: Number(c.id ?? i + 1), classificationPath: path };
  });

  // 5. Validate assignments
  const rawAssignments = result.assignments;
  if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) {
    throw new Error(`Expected "assignments" object in response`);
  }

  const assignments: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(rawAssignments as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new Error(`Assignment for classification ${key} is not an array`);
    }
    assignments[String(key)] = value.map(Number);
  }

  return { classifications, assignments };
}

/**
 * Normalize a taxonomy path segment or full path for fuzzy matching.
 * Lowercases, replaces hyphens/dashes with spaces, normalizes & → and, collapses whitespace.
 */
export function normalizePath(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
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

  // Try normalized match (punctuation-insensitive)
  const normalizedL1 = normalizePath(l1);
  const normalizedMatch = taxonomyL1Values.find(
    (v) => normalizePath(v) === normalizedL1
  );
  if (normalizedMatch) {
    parts[0] = normalizedMatch;
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

  // Normalized exact match (punctuation-insensitive)
  const normalizedPath = normalizePath(classificationPath);
  const normalizedMatch = taxonomy.find(
    (node) => normalizePath(node.fullPath) === normalizedPath
  );
  if (normalizedMatch) {
    return normalizedMatch.fullPath;
  }

  // Try matching L1|L2 and finding any L3 under it
  const parts = classificationPath.split('|');
  if (parts.length >= 2) {
    const l1l2Normalized = normalizePath(`${parts[0]}|${parts[1]}`);
    const partialMatch = taxonomy.find(
      (node) =>
        node.depth === 3 &&
        normalizePath(node.fullPath).startsWith(l1l2Normalized)
    );
    if (partialMatch) {
      return partialMatch.fullPath;
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
  const validatedClassifications = result.classifications.map((entry) => {
    let path = entry.classificationPath;

    // Validate L1
    const l1Fix = validateL1(path, taxonomy);
    if (l1Fix) path = l1Fix;

    // Validate depth
    const depthFix = validateDepth(path);
    if (depthFix) {
      path = depthFix;
    } else if (path.split('|').length < 3) {
      // Pad with Uncategorized
      const parts = path.split('|');
      while (parts.length < 3) parts.push('Uncategorized');
      path = parts.join('|');
    }

    // Find closest taxonomy match
    path = findClosestTaxonomyMatch(path, taxonomy);

    return { ...entry, classificationPath: path };
  });

  return { classifications: validatedClassifications, assignments: result.assignments };
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
        classifications: [{ id: 1, classificationPath: 'Indirect|Uncategorized|Uncategorized' }],
        assignments: {},
      };
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input);

    const start = Date.now();
    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 16384,
    });
    const elapsedMs = Date.now() - start;

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'classification-l3',
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    const rawResult = parseResponse(responseText);
    return validateClassification(rawResult, taxonomy);
  }
}
