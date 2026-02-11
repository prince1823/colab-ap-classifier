import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { CompanyContext } from '../../shared/types/project';
import type { SupplierInfo } from '../../shared/types/suppliers';
import * as llmClient from '../services/llm-client';

/**
 * Input data required to classify an invoice group.
 */
export interface ClassificationInput {
  transactions: Array<Record<string, unknown>>;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
  supplierResearch: SupplierInfo | null;
  historicalClassifications: { l1: string; l2: string; l3: string; count: number }[];
  isTailSpend: boolean;
}

/**
 * Result of classifying an invoice group.
 */
export interface ClassificationResult {
  classificationPath: string; // "L1|L2|L3"
  reasoning: string;
  descriptionSupplierAligned: boolean;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const VALID_L1_VALUES = ['Direct', 'Indirect', 'Exempt'];

/**
 * Build the system prompt for the classification agent.
 */
export function buildSystemPrompt(isTailSpend: boolean): string {
  if (isTailSpend) {
    return `You are an AP transaction classifier specializing in tail spend categorization.

## Rules
- L1 must be one of: Direct, Indirect, Exempt
- Always classify to exactly depth 3 in the format L1|L2|L3
- Prioritize supplier research when available to determine the correct classification
- Check for intercompany transactions - these should be classified under Exempt
- For tail spend, focus on the supplier name and any available description to make a quick determination

## Response Format
You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON):
{
  "classificationPath": "L1|L2|L3",
  "reasoning": "<brief explanation>",
  "descriptionSupplierAligned": true/false
}`;
  }

  return `You are an AP transaction classifier. Your task is to classify accounts payable transactions into a standardized taxonomy.

## Rules
- L1 must be one of: Direct, Indirect, Exempt
- Always classify to exactly depth 3 in the format L1|L2|L3
- Prioritize supplier research when available to determine the correct classification
- Check for intercompany transactions - these should be classified under Exempt
- Consider the company context and industry when making classification decisions
- Use historical classifications as guidance for consistency, but do not blindly follow them if the data suggests otherwise
- When the transaction description and supplier research conflict, weigh supplier research more heavily

## Classification Guidance
- **Direct**: Costs directly tied to production of goods/services (raw materials, manufacturing, direct labor)
- **Indirect**: Costs not directly tied to production (office supplies, IT services, consulting, facilities)
- **Exempt**: Intercompany transfers, taxes, employee reimbursements, non-procurement items

## Response Format
You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON):
{
  "classificationPath": "L1|L2|L3",
  "reasoning": "<detailed explanation of classification decision>",
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
export function formatSupplierResearch(supplier: SupplierInfo | null): string {
  if (!supplier) {
    return '(No supplier research available)';
  }

  const parts: string[] = [];
  if (supplier.officialBusinessName) parts.push(`Business Name: ${supplier.officialBusinessName}`);
  if (supplier.description) parts.push(`Description: ${supplier.description}`);
  if (supplier.industry) parts.push(`Industry: ${supplier.industry}`);
  if (supplier.productsServices) parts.push(`Products/Services: ${supplier.productsServices}`);
  if (supplier.parentCompany) parts.push(`Parent Company: ${supplier.parentCompany}`);
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

/**
 * Format transaction details into a readable block for the prompt.
 */
export function formatTransactions(transactions: Array<Record<string, unknown>>): string {
  if (transactions.length === 0) {
    return '(No transactions provided)';
  }

  return transactions
    .map((txn, i) => {
      const fields = Object.entries(txn)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `  ${k}: ${String(v)}`)
        .join('\n');
      return `Transaction ${i + 1}:\n${fields}`;
    })
    .join('\n\n');
}

/**
 * Build the user prompt with all classification context.
 */
export function buildUserPrompt(input: ClassificationInput): string {
  const { taxonomy, companyContext, supplierResearch, historicalClassifications, transactions, isTailSpend } = input;

  if (isTailSpend) {
    return `## Taxonomy
${formatTaxonomyTree(taxonomy)}

## Supplier Research
${formatSupplierResearch(supplierResearch)}

## Transactions
${formatTransactions(transactions)}

Classify the above transactions into the taxonomy. Respond with JSON only.`;
  }

  const contextParts: string[] = [];
  contextParts.push(`Industry: ${companyContext.industry}`);
  if (companyContext.sector) contextParts.push(`Sector: ${companyContext.sector}`);
  if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
  if (companyContext.businessFocus) contextParts.push(`Business Focus: ${companyContext.businessFocus}`);
  if (companyContext.procurementNuances) contextParts.push(`Procurement Nuances: ${companyContext.procurementNuances}`);

  return `## Taxonomy
${formatTaxonomyTree(taxonomy)}

## Company Context
${contextParts.join('\n')}

## Supplier Research
${formatSupplierResearch(supplierResearch)}

## Historical Classifications
${formatHistoricalClassifications(historicalClassifications)}

## Transactions
${formatTransactions(transactions)}

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
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned.substring(0, 200)}`);
  }

  const data = parsed as Record<string, unknown>;

  if (typeof data.classificationPath !== 'string' || !data.classificationPath) {
    throw new Error('LLM response missing "classificationPath" string');
  }

  return {
    classificationPath: data.classificationPath,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
    descriptionSupplierAligned:
      typeof data.descriptionSupplierAligned === 'boolean'
        ? data.descriptionSupplierAligned
        : false,
  };
}

/**
 * Validate that L1 is one of the allowed values (Direct, Indirect, Exempt).
 * Returns the corrected path if L1 was invalid, or null if it cannot be corrected.
 */
export function validateL1(classificationPath: string): string | null {
  const parts = classificationPath.split('|');
  if (parts.length === 0) return null;

  const l1 = parts[0];
  if (VALID_L1_VALUES.includes(l1)) {
    return classificationPath;
  }

  // Try case-insensitive match
  const matched = VALID_L1_VALUES.find(
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
  const validatedL1 = validateL1(path);
  if (validatedL1 === null) {
    // Default to Indirect if L1 is unrecognizable
    const parts = path.split('|');
    parts[0] = 'Indirect';
    path = parts.join('|');
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
 * Classify an invoice group using the LLM.
 *
 * @param input - All data needed for classification
 * @returns The classification result with path, reasoning, and alignment flag
 */
export async function classifyInvoiceGroup(
  input: ClassificationInput
): Promise<ClassificationResult> {
  const { taxonomy, isTailSpend } = input;

  if (input.transactions.length === 0) {
    return {
      classificationPath: 'Indirect|Uncategorized|Uncategorized',
      reasoning: 'No transactions provided for classification.',
      descriptionSupplierAligned: false,
    };
  }

  const systemPrompt = buildSystemPrompt(isTailSpend);
  const userPrompt = buildUserPrompt(input);

  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    model: DEFAULT_MODEL,
    temperature: 0,
    maxTokens: 4096,
  });

  const rawResult = parseResponse(responseText);
  return validateClassification(rawResult, taxonomy);
}
