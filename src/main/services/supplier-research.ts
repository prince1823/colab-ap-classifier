import { researchSupplier } from '../agents/research-agent';
import { readSupplierUniverse } from './colabip';
import * as exaSearch from './exa-search';
import * as supplierService from './suppliers';
import * as projectService from './project';
import type { SupplierResearchResult, SupplierInfo } from '../../shared/types';

/**
 * Research a single supplier and store results.
 */
export async function researchSingle(supplierName: string): Promise<SupplierResearchResult> {
  // Check supplier universe first
  const universe = await readSupplierUniverse();
  const knownSupplier = universe.find(
    (s) => s.supplierName.toLowerCase() === supplierName.toLowerCase()
  );

  if (knownSupplier) {
    const result: SupplierResearchResult = {
      officialBusinessName: knownSupplier.supplierName,
      industry: knownSupplier.industry,
      parentCompany: knownSupplier.parentCompany,
      websiteUrl: knownSupplier.website,
      confidence: 'high' as const,
      sources: ['ColabIP Supplier Universe'],
    };

    await supplierService.updateSupplier(supplierName, {
      supplierInfo: result as SupplierInfo,
      supplierType: (knownSupplier.supplierType as 'company' | 'individual' | 'government') || null,
    });

    return result;
  }

  // Get company context and project name for research and retry disambiguation
  let companyContext;
  let projectName: string | undefined;
  try {
    const metadata = await projectService.getMetadata();
    companyContext = metadata.companyContext ?? undefined;
    projectName = metadata.name || undefined;
  } catch {
    // Project might not be open or metadata unavailable
  }

  // Get supplier address if available
  const existing = await supplierService.getSupplierByName(supplierName);
  const address = existing?.supplierInfo?.supplierAddress;

  // Search Exa for web data (gracefully returns [] if unavailable)
  let searchResults: exaSearch.ExaSearchResult[] = [];
  try {
    searchResults = await exaSearch.searchSupplier(supplierName, address);
  } catch (error) {
    console.error(`[SupplierResearch] Exa search failed for ${supplierName}, falling back to LLM-only:`, error);
  }

  // Research via LLM, enriched with web search results
  let result = await researchSupplier(supplierName, companyContext, address, searchResults);

  // Track that Exa was used as a source
  if (searchResults.length > 0 && !result.sources.includes('Exa Web Search')) {
    result.sources.push('Exa Web Search');
  }

  // Retry with project name if confidence is low — helps disambiguate common names
  // TODO: Replace projectName with companyContext.companyName once that field exists (see GitHub issue)
  if (result.confidence === 'low' && projectName) {
    try {
      const retryResults = await exaSearch.searchSupplier(
        `${supplierName} ${projectName}`,
        address
      );
      if (retryResults.length > 0) {
        result = await researchSupplier(supplierName, companyContext, address, retryResults);
        if (!result.sources.includes('Exa Web Search')) {
          result.sources.push('Exa Web Search');
        }
      }
    } catch (error) {
      console.error(`[SupplierResearch] Exa retry with project name failed for ${supplierName}:`, error);
    }
  }

  // Store results
  await supplierService.updateSupplier(supplierName, {
    supplierInfo: result as SupplierInfo,
    supplierType: result.confidence !== 'low'
      ? determineSupplierType(result)
      : null,
  });

  return result;
}

/**
 * Research multiple suppliers in parallel batches.
 */
export async function researchBatch(
  supplierNames: string[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const BATCH_SIZE = 5;
  let done = 0;
  const total = supplierNames.length;

  // Filter out already-researched suppliers
  const toResearch: string[] = [];
  for (const name of supplierNames) {
    const supplier = await supplierService.getSupplierByName(name);
    if (!supplier?.supplierInfo) {
      toResearch.push(name);
    } else {
      done++;
    }
  }

  if (onProgress) onProgress(done, total);

  // Process in batches
  for (let i = 0; i < toResearch.length; i += BATCH_SIZE) {
    const batch = toResearch.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (name) => {
      try {
        await researchSingle(name);
      } catch (error) {
        console.error(`[SupplierResearch] Failed to research ${name}:`, error);
      }
      done++;
      if (onProgress) onProgress(done, total);
    });
    await Promise.all(promises);
  }
}

function determineSupplierType(result: SupplierResearchResult): 'company' | 'individual' | 'government' | null {
  const desc = (result.description || '').toLowerCase();
  const industry = (result.industry || '').toLowerCase();
  const model = (result.primaryBusinessModel || '').toLowerCase();

  if (
    industry.includes('government') ||
    desc.includes('municipality') ||
    desc.includes('government agency')
  ) {
    // Government utilities exception
    if (
      desc.includes('electricity') ||
      desc.includes('water utility') ||
      desc.includes('gas utility')
    ) {
      return 'company';
    }
    return 'government';
  }

  if (
    model.includes('freelance') ||
    model.includes('sole proprietor') ||
    desc.includes('individual contractor')
  ) {
    return 'individual';
  }

  return 'company';
}
