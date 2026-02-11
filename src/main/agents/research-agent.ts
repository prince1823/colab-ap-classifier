import type { ConfidenceLevel } from '../../shared/types/canonicalization';
import type { CompanyContext } from '../../shared/types/project';
import type { SupplierResearchResult } from '../../shared/types/suppliers';
import * as llmClient from '../services/llm-client';
import * as settingsService from '../services/settings';

/**
 * Build the system prompt for the supplier research agent.
 */
export function buildSystemPrompt(): string {
  return `You are a supplier research analyst. Your task is to research a supplier and determine their type, industry, offerings, and other metadata based on their name and any additional context provided.

## Supplier Type Rules

Classify the supplier into exactly one of these types:

- **company** — businesses, corporations, LLCs, partnerships, and other commercial entities. Government-owned utilities (e.g., municipal water, electric companies) should be typed as "company", NOT "government".
- **government** — government entities, municipalities, agencies, departments, bureaus, and other public-sector bodies. Do NOT classify government-owned utilities as "government".
- **individual** — sole proprietors, freelancers, independent contractors, or personal names that appear to be individuals rather than businesses.

## Research Fields

For each supplier, determine as many of the following fields as possible:

- officialBusinessName: The supplier's official registered business name
- description: A brief description of what the supplier does
- websiteUrl: The supplier's website URL
- industry: The primary industry the supplier operates in
- productsServices: Key products or services offered
- parentCompany: The parent company, if any
- supplierAddress: Known address of the supplier
- serviceType: The type of service provided (e.g., "Software", "Consulting", "Manufacturing")
- naicsCode: The NAICS code that best fits the supplier
- naicsDescription: Description of the NAICS code
- sicCode: The SIC code that best fits the supplier
- primaryBusinessModel: The supplier's primary business model (e.g., "B2B", "B2C", "B2G")
- primaryRevenueStreams: How the supplier primarily generates revenue
- serviceCategories: Categories of services offered
- targetMarket: The supplier's target market

## Confidence Levels

- **high** — You are confident in the supplier identification and most fields are well-known
- **medium** — You have a reasonable idea of the supplier but some fields are uncertain
- **low** — The supplier name is ambiguous or you have very limited information

## Response Format

You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON). Use this exact structure:

{
  "supplierType": "company" | "government" | "individual",
  "officialBusinessName": "<string or null>",
  "description": "<string or null>",
  "websiteUrl": "<string or null>",
  "industry": "<string or null>",
  "productsServices": "<string or null>",
  "parentCompany": "<string or null>",
  "supplierAddress": "<string or null>",
  "serviceType": "<string or null>",
  "naicsCode": "<string or null>",
  "naicsDescription": "<string or null>",
  "sicCode": "<string or null>",
  "primaryBusinessModel": "<string or null>",
  "primaryRevenueStreams": "<string or null>",
  "serviceCategories": "<string or null>",
  "targetMarket": "<string or null>",
  "confidence": "high" | "medium" | "low",
  "sources": ["<list of sources or reasoning used>"]
}`;
}

/**
 * Build the user prompt with supplier name and optional context.
 */
export function buildUserPrompt(
  supplierName: string,
  companyContext?: CompanyContext,
  supplierAddress?: string
): string {
  const sections: string[] = [];

  sections.push(`## Supplier Name\n\n${supplierName}`);

  if (supplierAddress) {
    sections.push(`## Supplier Address\n\n${supplierAddress}`);
  }

  if (companyContext) {
    const contextParts: string[] = [];
    contextParts.push(`Industry: ${companyContext.industry}`);
    if (companyContext.sector) contextParts.push(`Sector: ${companyContext.sector}`);
    if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
    if (companyContext.businessFocus) contextParts.push(`Business Focus: ${companyContext.businessFocus}`);
    if (companyContext.procurementNuances) contextParts.push(`Procurement Nuances: ${companyContext.procurementNuances}`);

    sections.push(`## Purchasing Company Context\n\n${contextParts.join('\n')}`);
  }

  sections.push(
    'Research this supplier and respond with JSON only.'
  );

  return sections.join('\n\n');
}

/**
 * Parse and validate the JSON response from the LLM into a SupplierResearchResult.
 */
export function parseResponse(responseText: string): SupplierResearchResult {
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

  const parentCompany = optStr('parentCompany');
  if (parentCompany) result.parentCompany = parentCompany;

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

  return result;
}

/**
 * Research a supplier using the LLM to determine their type, industry,
 * offerings, and other metadata.
 *
 * @param supplierName - The name of the supplier to research
 * @param companyContext - Optional context about the purchasing company
 * @param supplierAddress - Optional known address of the supplier
 * @returns A SupplierResearchResult with supplier metadata and confidence
 */
export async function researchSupplier(
  supplierName: string,
  companyContext?: CompanyContext,
  supplierAddress?: string
): Promise<SupplierResearchResult> {
  if (!supplierName.trim()) {
    return {
      confidence: 'low',
      sources: [],
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(supplierName, companyContext, supplierAddress);

  // Use model from settings (configured via .env or runtime)
  const settings = settingsService.getSettings();
  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    model: settings.model,
    temperature: 0,
    maxTokens: 4096,
  });

  return parseResponse(responseText);
}
