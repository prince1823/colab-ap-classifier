import type { ConfidenceLevel } from '../../shared/types/column-mapping';
import type { CompanyContext } from '../../shared/types/project';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type { ExaSearchResult } from '../services/exa-search';
import type { ResearchAgent, LLMClient } from '../../shared/types/services';
import * as llmClient from '../services/llm-client';
import { traceLog } from '../utils/llm-trace';

export interface SupplierResearchResult extends SupplierInfo {
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

/**
 * Build the system prompt for the supplier research agent.
 */
export function buildSystemPrompt(): string {
  return `You are a supplier research analyst. Extract structured supplier information for spend classification.

CONTEXT: This agent runs as the first step of classification. It researches
suppliers that don't already have data before classification proceeds. Results (including
supplierType) are stored in the supplier_universe.suppliers.supplier_info JSON column.

STRATEGY: Use supplier address if available. Prioritize first result (official website).
Check "Services"/"About Us" for L1. Extract address if found. Select most relevant result if multiple.

Extract: supplier_type, industry/sector, products/services, official name, address/location.
Also extract enhanced classification fields: service type, NAICS/SIC codes, business model, revenue streams.
Be concise. Use null if not found — do NOT guess.

## Supplier Type (Critical Output)

Classify every supplier as one of:
- **company** — registered business entity. Government-owned utilities (e.g., municipal water, electric companies) should be typed as "company", NOT "government".
- **individual** — sole proprietor, freelancer, individual contractor
- **government** — government entity, agency, municipality, regulatory body. Do NOT classify government-owned utilities as "government".
  Government indicators: "Department of", "IRS", "state/city/county", "authority",
  "treasury", "regulatory agency", "licensing agency", "municipal", "federal"
- **null** — cannot determine from available information

Supplier type is passed to the classification LLM as a signal. Government supplierType
strongly suggests Exempt classification (except government utilities).

## NAICS/SIC Codes
Extract standardized industry codes if available. These help with precise classification.
Examples: NAICS "481111" (Scheduled Passenger Air Transportation), "541611" (Administrative Management Consulting)

## Business Model
Identify primary business model: "B2B Services", "B2C Retail", "B2B Products", "Mixed"

## Parent Company
If this supplier is a subsidiary, division, or brand owned by a larger corporation, populate
\`parentCompanyName\` with the official name of the owning entity. Return null if the supplier
is the top-level entity with no corporate parent, or if the parent company is not known from
the research.

## Confidence Levels

- **high** — Found official info, confident in supplier identification and most fields
- **medium** — Partial info, reasonable idea of the supplier but some fields uncertain
- **low** — Limited/no info, supplier name is ambiguous

## Response Format

You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON). Use this exact structure:

{
  "supplierType": "company" | "government" | "individual" | null,
  "officialBusinessName": "<string or null>",
  "description": "<brief 2-3 sentence description or null>",
  "websiteUrl": "<string or null>",
  "industry": "<string or null>",
  "productsServices": "<string or null>",
  "supplierAddress": "<string or null>",
  "serviceType": "<brief description of primary service type or null>",
  "naicsCode": "<string or null>",
  "naicsDescription": "<string or null>",
  "sicCode": "<string or null>",
  "primaryBusinessModel": "<'B2B Services' | 'B2C Retail' | 'B2B Products' | 'Mixed' or null>",
  "primaryRevenueStreams": "<comma-separated or null>",
  "serviceCategories": "<comma-separated categories mapping to taxonomy or null>",
  "targetMarket": "<'Enterprise' | 'SMB' | 'Consumer' | 'Healthcare' | 'Government' | 'Mixed' or null>",
  "parentCompanyName": "<official name of the parent/holding company, or null if independent>",
  "confidence": "high" | "medium" | "low",
  "sources": ["<list of source URLs used for the research>"]
}`;
}

/**
 * Build the user prompt with supplier name and optional context.
 */
export function buildUserPrompt(
  supplierName: string,
  companyContext?: CompanyContext,
  supplierAddress?: string,
  searchResults?: ExaSearchResult[]
): string {
  const sections: string[] = [];

  sections.push(`## Supplier Name\n\n${supplierName}`);

  if (supplierAddress) {
    sections.push(`## Supplier Address\n\n${supplierAddress}`);
  }

  if (companyContext) {
    const contextParts: string[] = [];
    contextParts.push(`Industry: ${companyContext.industry}`);
    if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
    if (companyContext.sisterCompanies) contextParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
    if (companyContext.additionalDetails) contextParts.push(`Additional Details: ${companyContext.additionalDetails}`);

    sections.push(`## Purchasing Company Context\n\n${contextParts.join('\n')}`);
  }

  if (searchResults && searchResults.length > 0) {
    const resultTexts = searchResults.map((r, i) => {
      const parts = [`### Result ${i + 1}: ${r.title}`, `URL: ${r.url}`];
      if (r.publishedDate) parts.push(`Published: ${r.publishedDate}`);
      parts.push('', r.text);
      return parts.join('\n');
    });
    sections.push(`## Web Search Results\n\nThe following web search results were found for this supplier. Use these to extract accurate, verified information. Prioritize data from these results over your training data.\n\n${resultTexts.join('\n\n')}`);
  }

  sections.push(
    'Research this supplier and respond with JSON only.'
  );

  return sections.join('\n\n');
}

export interface ResearchParseResult {
  result: SupplierResearchResult;
}

/**
 * Parse and validate the JSON response from the LLM.
 * Returns the SupplierResearchResult with supplierType included.
 */
export function parseResponse(responseText: string): ResearchParseResult {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
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

  // Validate confidence
  const validConfidenceLevels: ConfidenceLevel[] = ['high', 'medium', 'low'];
  const confidence = validConfidenceLevels.includes(
    data.confidence as ConfidenceLevel
  )
    ? (data.confidence as ConfidenceLevel)
    : 'low';

  // Validate sources
  const sources: string[] = Array.isArray(data.sources)
    ? data.sources.filter((item): item is string => typeof item === 'string')
    : [];

  // Helper to extract optional string fields
  const optStr = (key: string): string | undefined => {
    const val = data[key];
    return typeof val === 'string' && val.length > 0 ? val : undefined;
  };

  const result: SupplierResearchResult = {
    confidence,
    sources,
  };

  // Populate optional SupplierInfo fields
  const officialBusinessName = optStr('officialBusinessName');
  if (officialBusinessName) result.officialBusinessName = officialBusinessName;

  const description = optStr('description');
  if (description) result.description = description;

  const websiteUrl = optStr('websiteUrl');
  if (websiteUrl) result.websiteUrl = websiteUrl;

  const industry = optStr('industry');
  if (industry) result.industry = industry;

  const productsServices = optStr('productsServices');
  if (productsServices) result.productsServices = productsServices;

  const supplierAddress = optStr('supplierAddress');
  if (supplierAddress) result.supplierAddress = supplierAddress;

  const serviceType = optStr('serviceType');
  if (serviceType) result.serviceType = serviceType;

  const naicsCode = optStr('naicsCode');
  if (naicsCode) result.naicsCode = naicsCode;

  const naicsDescription = optStr('naicsDescription');
  if (naicsDescription) result.naicsDescription = naicsDescription;

  const sicCode = optStr('sicCode');
  if (sicCode) result.sicCode = sicCode;

  const primaryBusinessModel = optStr('primaryBusinessModel');
  if (primaryBusinessModel) result.primaryBusinessModel = primaryBusinessModel;

  const primaryRevenueStreams = optStr('primaryRevenueStreams');
  if (primaryRevenueStreams) result.primaryRevenueStreams = primaryRevenueStreams;

  const serviceCategories = optStr('serviceCategories');
  if (serviceCategories) result.serviceCategories = serviceCategories;

  const targetMarket = optStr('targetMarket');
  if (targetMarket) result.targetMarket = targetMarket;

  const supplierType = optStr('supplierType');
  if (supplierType) result.supplierType = supplierType;

  const parentCompanyName = optStr('parentCompanyName');
  if (parentCompanyName) result.parentCompanyName = parentCompanyName;

  return { result };
}

/**
 * Research a supplier using the LLM to determine their type, industry,
 * offerings, and other metadata.
 *
 * @param supplierName - The name of the supplier to research
 * @param companyContext - Optional context about the purchasing company
 * @param supplierAddress - Optional known address of the supplier
 * @param searchResults - Optional Exa web search results to include as context
 * @returns A ResearchParseResult with supplier metadata (including supplierType)
 */
export async function researchSupplier(
  supplierName: string,
  companyContext?: CompanyContext,
  supplierAddress?: string,
  searchResults?: ExaSearchResult[]
): Promise<ResearchParseResult> {
  if (!supplierName.trim()) {
    return {
      result: { confidence: 'low', sources: [] },
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(supplierName, companyContext, supplierAddress, searchResults);

  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    temperature: 0,
    maxTokens: 1024,
  });

  return parseResponse(responseText);
}

/**
 * DI-compatible research agent class.
 */
export class LLMResearchAgent implements ResearchAgent {
  constructor(private llm: LLMClient) {}

  async researchSupplier(
    supplierName: string,
    context?: unknown,
    supplierAddress?: string,
    searchResults?: Array<{ title: string; url: string; text: string }>
  ): Promise<SupplierInfo> {
    if (!supplierName.trim()) {
      return {};
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(
      supplierName,
      context as CompanyContext | undefined,
      supplierAddress,
      searchResults as ExaSearchResult[] | undefined
    );

    const start = Date.now();
    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 1024,
    });
    const elapsedMs = Date.now() - start;

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'research',
      supplier: supplierName,
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    const { result } = parseResponse(responseText);
    return result;
  }
}
