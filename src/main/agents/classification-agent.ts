import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type {
  ClassificationInput,
  ClassificationResult,
  ClassificationEntry,
  CategorySelectionInput,
  L3ClassificationInput,
} from '../../shared/types/classification';
import type { ClassificationAgent, LLMClient } from '../../shared/types/services';
import type { CompanyContext } from '../../shared/types/project';
import { extractFields, buildDedupGroups } from '../utils/dedup-groups';
import { traceLog } from '../utils/llm-trace';

// ─── Call 1: Category Selection ─────────────────────────────────────────────

/**
 * Build the system prompt for Call 1 (category selection).
 */
export function buildCategorySelectionSystemPrompt(): string {
  return `You are a supplier category classifier. Given supplier identities and research, determine which L1|L2 spend category each supplier belongs to.

Rules:
- Return exactly one L1|L2 path per supplier
- Government supplier type is a strong signal for Exempt classification
  - EXCEPTION: Government utility payments (electricity, water, gas) → appropriate Utilities category, NOT Exempt
- Intercompany/subsidiary suppliers → Exempt
- Use supplier research (industry, products, NAICS) as primary signal
- Use supplier name as fallback when research is unavailable
- Company context helps interpret domain-specific suppliers

Response format (JSON only, no markdown fencing):
{"categories": [
  {"supplierIndex": 1, "categoryPath": "L1|L2"},
  {"supplierIndex": 2, "categoryPath": "L1|L2"}
]}`;
}

/**
 * Build the user prompt for Call 1 (category selection).
 */
export function buildCategorySelectionUserPrompt(input: CategorySelectionInput): string {
  const { suppliers, taxonomy, companyContext } = input;

  const l1l2Taxonomy = formatL1L2Taxonomy(taxonomy);

  const contextParts: string[] = [];
  contextParts.push(`Industry: ${companyContext.industry}`);
  if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
  if (companyContext.sisterCompanies) contextParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
  if (companyContext.additionalDetails) contextParts.push(`Additional Details: ${companyContext.additionalDetails}`);

  const supplierSections = suppliers.map((s, i) => {
    const parts: string[] = [`Supplier ${i + 1}: ${s.name}`];
    if (s.research) {
      const research = formatSupplierResearch(s.research, s.parentName);
      if (research !== '(No supplier research available)') {
        parts.push(research);
      }
    } else if (s.parentName) {
      parts.push(`Parent Company: ${s.parentName}`);
    }
    return parts.join('\n  ');
  });

  return `## L1|L2 Taxonomy
${l1l2Taxonomy}

## Company Context
${contextParts.join('\n')}

## Suppliers
${supplierSections.join('\n\n')}

For each supplier, select the single best L1|L2 category. Respond with JSON only.`;
}

/**
 * Parse the Call 1 response into a Map of supplierIndex → categoryPath.
 */
export function parseCategorySelectionResponse(responseText: string): Map<number, string> {
  let cleaned = responseText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse category selection response: ${cleaned.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  // Handle both {"categories": [...]} and {"categoryPath": "..."} (single supplier)
  if (obj.categoryPath && typeof obj.categoryPath === 'string') {
    return new Map([[1, obj.categoryPath]]);
  }

  if (!Array.isArray(obj.categories)) {
    throw new Error(`Expected "categories" array in response`);
  }

  const result = new Map<number, string>();
  for (const entry of obj.categories) {
    if (!entry || typeof entry !== 'object') continue;
    const idx = Number(entry.supplierIndex);
    let path = entry.categoryPath;
    if (Array.isArray(path) && path.length === 1) path = path[0];
    if (typeof path === 'string' && path && !isNaN(idx)) {
      result.set(idx, path);
    }
  }

  return result;
}

// ─── Call 2: L3 Classification ──────────────────────────────────────────────

/**
 * Build the system prompt for Call 2 (L3 classification).
 */
export function buildL3ClassificationSystemPrompt(): string {
  return `You are a transaction classifier. Classify transactions into L3 categories within the provided taxonomy branch.

Rules:
- Must return exactly L1|L2|L3 (3 levels)
- Transaction fields are in priority order (most important first)
- Prefer specific categories over "Other"
- Tax/adjustment lines for non-government suppliers: classify with primary spend

Response format (JSON only, no markdown fencing):
{
  "classifications": [
    { "id": 1, "classificationPath": "L1|L2|L3" }
  ],
  "assignments": {
    "1": [1, 2, 3]
  }
}

Rules:
- Each classification has a unique integer id and a pipe-delimited taxonomy path at depth 3
- "assignments" maps each classification id to the Group numbers it applies to
- Every Group number from the Transactions section must appear in exactly one assignment entry
- Prefer a SINGLE classification when all transactions clearly belong to one L3 category
- Do NOT include "reasoning" or any fields other than "classifications" and "assignments"`;
}

/**
 * Build the user prompt for Call 2 (L3 classification).
 */
export function buildL3ClassificationUserPrompt(input: L3ClassificationInput): string {
  const { categoryPath, l3Taxonomy, transactions, columnPriorities, companyContext, supplierName, supplierType } = input;

  const contextParts: string[] = [];
  contextParts.push(`Industry: ${companyContext.industry}`);
  if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
  if (companyContext.sisterCompanies) contextParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
  if (companyContext.additionalDetails) contextParts.push(`Additional Details: ${companyContext.additionalDetails}`);

  const taxonomyLines = l3Taxonomy.map((n) => {
    const desc = n.description ? ` - ${n.description}` : '';
    return `  ${n.fullPath}${desc}`;
  });

  const supplierContext = supplierType
    ? `Supplier: ${supplierName} (${supplierType})`
    : `Supplier: ${supplierName}`;

  return `## Category Branch: ${categoryPath}

## Available L3 Categories
${taxonomyLines.join('\n')}

## Company Context
${contextParts.join('\n')}

## Supplier
${supplierContext}

## Transactions
Transaction fields are listed in order of classification priority (most important first). Identical rows are grouped with a count.

${formatTransactions(transactions, columnPriorities)}

Classify the above transactions into the L3 categories. Respond with JSON only.`;
}

// ─── Shared Utilities (exported for tests) ──────────────────────────────────

/**
 * Format taxonomy nodes as L1|L2 only (for Call 1).
 * Returns unique L1|L2 paths with L2-level descriptions.
 */
export function formatL1L2Taxonomy(taxonomy: TaxonomyNode[]): string {
  if (taxonomy.length === 0) return '(No taxonomy provided)';

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const node of taxonomy) {
    if (node.depth === 2 || (node.depth === 3 && node.l2)) {
      const l1l2 = `${node.l1}|${node.l2}`;
      if (seen.has(l1l2)) continue;
      seen.add(l1l2);

      // Use L2 node description if available
      const l2Node = taxonomy.find((n) => n.depth === 2 && n.l1 === node.l1 && n.l2 === node.l2);
      const desc = l2Node?.description ? ` - ${l2Node.description}` : '';
      lines.push(`  ${l1l2}${desc}`);
    }
  }

  if (lines.length === 0) {
    // Fallback: just list L1|L2 from all nodes
    for (const node of taxonomy) {
      const l1l2 = `${node.l1}|${node.l2}`;
      if (seen.has(l1l2)) continue;
      seen.add(l1l2);
      lines.push(`  ${l1l2}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the original system prompt for backward compatibility (classifyTransactionGroup).
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
 */
export function formatTransactions(
  transactions: Array<Record<string, unknown>>,
  columnPriorities?: string[]
): string {
  if (transactions.length === 0) {
    return '(No transactions provided)';
  }

  if (columnPriorities && columnPriorities.length > 0) {
    const result = buildDedupGroups(transactions, columnPriorities);
    return result.promptText;
  }

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
 * Build the user prompt with all classification context (backward compat).
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
  let cleaned = responseText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse classification response as JSON: ${cleaned.slice(0, 200)}`);
  }

  // Handle wrapper objects
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (!obj.classifications && obj.result && typeof obj.result === 'object') {
      parsed = obj.result;
    }
  }

  const result = parsed as Record<string, unknown>;

  if (!Array.isArray(result.classifications)) {
    throw new Error(`Expected "classifications" array in response, got: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const classifications: ClassificationEntry[] = result.classifications.map((c: any, i: number) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`Classification entry ${i} is not an object`);
    }
    let path = c.classificationPath ?? c.classification_path ?? c.path;
    if (Array.isArray(path) && path.length === 1) path = path[0];
    if (typeof path !== 'string' || !path) {
      throw new Error(`Classification entry ${i} missing classificationPath`);
    }
    return { id: Number(c.id ?? i + 1), classificationPath: path };
  });

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

// ─── Validation Utilities ───────────────────────────────────────────────────

export function normalizePath(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateL1(classificationPath: string, taxonomy: TaxonomyNode[]): string | null {
  const parts = classificationPath.split('|');
  if (parts.length === 0) return null;
  const l1 = parts[0];
  const taxonomyL1Values = [...new Set(taxonomy.map(node => node.l1))];

  if (taxonomyL1Values.includes(l1)) return classificationPath;

  const matched = taxonomyL1Values.find((v) => v.toLowerCase() === l1.toLowerCase());
  if (matched) { parts[0] = matched; return parts.join('|'); }

  const normalizedL1 = normalizePath(l1);
  const normalizedMatch = taxonomyL1Values.find((v) => normalizePath(v) === normalizedL1);
  if (normalizedMatch) { parts[0] = normalizedMatch; return parts.join('|'); }

  return null;
}

export function validateDepth(classificationPath: string): string | null {
  const parts = classificationPath.split('|').filter((p) => p.trim().length > 0);
  if (parts.length === 3) return parts.join('|');
  if (parts.length > 3) return parts.slice(0, 3).join('|');
  return null;
}

export function findClosestTaxonomyMatch(
  classificationPath: string,
  taxonomy: TaxonomyNode[]
): string {
  const exactMatch = taxonomy.find((node) => node.fullPath === classificationPath);
  if (exactMatch) return exactMatch.fullPath;

  const lowerPath = classificationPath.toLowerCase();
  const caseMatch = taxonomy.find((node) => node.fullPath.toLowerCase() === lowerPath);
  if (caseMatch) return caseMatch.fullPath;

  const normalizedPath = normalizePath(classificationPath);
  const normalizedMatch = taxonomy.find((node) => normalizePath(node.fullPath) === normalizedPath);
  if (normalizedMatch) return normalizedMatch.fullPath;

  const parts = classificationPath.split('|');
  if (parts.length >= 2) {
    const l1l2Normalized = normalizePath(`${parts[0]}|${parts[1]}`);
    const partialMatch = taxonomy.find(
      (node) => node.depth === 3 && normalizePath(node.fullPath).startsWith(l1l2Normalized)
    );
    if (partialMatch) return partialMatch.fullPath;
  }

  return classificationPath;
}

/**
 * Validate a category path (L1|L2) against the taxonomy.
 * Returns the matched L1|L2 path or null.
 */
export function validateCategoryPath(categoryPath: string, taxonomy: TaxonomyNode[]): string | null {
  const parts = categoryPath.split('|').filter((p) => p.trim().length > 0);
  if (parts.length < 2) return null;
  const l1l2 = `${parts[0]}|${parts[1]}`;

  // Build set of valid L1|L2 paths
  const validL1L2 = new Set<string>();
  for (const node of taxonomy) {
    if (node.l1 && node.l2) validL1L2.add(`${node.l1}|${node.l2}`);
  }

  if (validL1L2.has(l1l2)) return l1l2;

  // Case-insensitive
  const lower = l1l2.toLowerCase();
  for (const path of validL1L2) {
    if (path.toLowerCase() === lower) return path;
  }

  // Normalized
  const normalized = normalizePath(l1l2);
  for (const path of validL1L2) {
    if (normalizePath(path) === normalized) return path;
  }

  return null;
}

export function validateClassification(
  result: ClassificationResult,
  taxonomy: TaxonomyNode[]
): ClassificationResult {
  const validatedClassifications = result.classifications.map((entry) => {
    let path = entry.classificationPath;
    const l1Fix = validateL1(path, taxonomy);
    if (l1Fix) path = l1Fix;
    const depthFix = validateDepth(path);
    if (depthFix) {
      path = depthFix;
    } else if (path.split('|').length < 3) {
      const parts = path.split('|');
      while (parts.length < 3) parts.push('Uncategorized');
      path = parts.join('|');
    }
    path = findClosestTaxonomyMatch(path, taxonomy);
    return { ...entry, classificationPath: path };
  });

  return { classifications: validatedClassifications, assignments: result.assignments };
}

// ─── Agent Class ────────────────────────────────────────────────────────────

/**
 * DI-compatible classification agent with 2-call architecture.
 */
export class LLMClassificationAgent implements ClassificationAgent {
  constructor(private llm: LLMClient) {}

  /**
   * Call 1: Select L1|L2 categories for a batch of suppliers.
   * Returns Map of 1-based supplier index → categoryPath.
   */
  async selectCategories(input: CategorySelectionInput): Promise<Map<number, string>> {
    const systemPrompt = buildCategorySelectionSystemPrompt();
    const userPrompt = buildCategorySelectionUserPrompt(input);

    const start = Date.now();
    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 4096,
    });
    const elapsedMs = Date.now() - start;

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'classification-category',
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    const result = parseCategorySelectionResponse(responseText);

    // Validate each path against taxonomy
    const validated = new Map<number, string>();
    for (const [idx, path] of result) {
      const match = validateCategoryPath(path, input.taxonomy);
      if (match) {
        validated.set(idx, match);
      } else {
        // Try fuzzy: find any L3 node matching this L1|L2 prefix
        const parts = path.split('|');
        if (parts.length >= 2) {
          const fuzzy = findClosestTaxonomyMatch(`${parts[0]}|${parts[1]}|_`, input.taxonomy);
          const fuzzyParts = fuzzy.split('|');
          if (fuzzyParts.length >= 2) {
            const l1l2 = `${fuzzyParts[0]}|${fuzzyParts[1]}`;
            const recheck = validateCategoryPath(l1l2, input.taxonomy);
            if (recheck) validated.set(idx, recheck);
          }
        }
      }
    }

    return validated;
  }

  /**
   * Call 2: Classify transactions into L3 categories within a given L1|L2 branch.
   */
  async classifyL3(input: L3ClassificationInput): Promise<ClassificationResult> {
    if (input.transactions.length === 0) {
      return {
        classifications: [{ id: 1, classificationPath: `${input.categoryPath}|Uncategorized` }],
        assignments: {},
      };
    }

    if (input.l3Taxonomy.length === 0) {
      throw new Error(`No L3 nodes found under category path "${input.categoryPath}"`);
    }

    const systemPrompt = buildL3ClassificationSystemPrompt();
    const userPrompt = buildL3ClassificationUserPrompt(input);

    const start = Date.now();
    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 16384,
    });
    const elapsedMs = Date.now() - start;

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'classification-l3',
      supplier: input.supplierName,
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    const rawResult = parseResponse(responseText);
    return validateClassification(rawResult, input.l3Taxonomy);
  }

  /**
   * Backward compat wrapper: runs Call 1 (single supplier) + Call 2.
   */
  async classifyTransactionGroup(input: ClassificationInput): Promise<ClassificationResult> {
    const { taxonomy, companyContext, supplierResearch, parentName, transactions, columnPriorities } = input;

    if (transactions.length === 0) {
      return {
        classifications: [{ id: 1, classificationPath: 'Indirect|Uncategorized|Uncategorized' }],
        assignments: {},
      };
    }

    // Determine supplier name from transactions
    const supplierName = (transactions[0]?.supplier_name as string) || 'Unknown';

    // Call 1: select category
    const categoryMap = await this.selectCategories({
      suppliers: [{ name: supplierName, research: supplierResearch, parentName: parentName ?? null }],
      taxonomy,
      companyContext,
    });

    const categoryPath = categoryMap.get(1);
    if (!categoryPath) {
      // Fallback: use original single-call approach
      return this._legacyClassify(input);
    }

    // Filter taxonomy to L3 nodes under the chosen L1|L2
    const [l1, l2] = categoryPath.split('|');
    const l3Taxonomy = taxonomy.filter(
      (n) => n.depth === 3 && n.l1 === l1 && n.l2 === l2
    );

    if (l3Taxonomy.length === 0) {
      // No L3 under this L1|L2 — fall back
      return this._legacyClassify(input);
    }

    // Call 2: classify into L3
    return this.classifyL3({
      categoryPath,
      l3Taxonomy,
      transactions,
      columnPriorities,
      companyContext,
      supplierName,
      supplierType: supplierResearch?.supplierType ?? null,
    });
  }

  /** Legacy single-call classify — used as fallback */
  private async _legacyClassify(input: ClassificationInput): Promise<ClassificationResult> {
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
    return validateClassification(rawResult, input.taxonomy);
  }
}
