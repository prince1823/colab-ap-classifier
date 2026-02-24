import { researchSupplier } from '../agents/research-agent';
import { readSupplierUniverse } from './colabip';
import { buildMatcherIndex, type SupplierMatcherIndex } from './supplier-matcher';
import * as exaSearch from './exa-search';
import * as supplierService from './suppliers';
import * as projectService from './project';
import type { SupplierResearchResult, SupplierInfo } from '../../shared/types';

/**
 * Research a single supplier and store results.
 * Optionally accepts a pre-built matcher index to avoid rebuilding per call.
 */
export async function researchSingle(
  supplierName: string,
  matcher?: SupplierMatcherIndex
): Promise<SupplierResearchResult> {
  // Check supplier universe first (exact normalized name + alias match)
  if (!matcher) {
    const universe = await readSupplierUniverse();
    matcher = buildMatcherIndex(universe);
  }
  const knownSupplier = matcher.match(supplierName);

  if (knownSupplier) {
    const universeInfo = (knownSupplier.supplierInfo ?? {}) as SupplierInfo;
    const hasSubstantiveInfo = !!(universeInfo.industry || universeInfo.description);

    if (hasSubstantiveInfo) {
      // Universe has real data — use it directly, skip LLM research
      const result: SupplierResearchResult = {
        ...universeInfo,
        officialBusinessName: universeInfo.officialBusinessName ?? knownSupplier.supplierName,
        confidence: 'high' as const,
        sources: ['ColabIP Supplier Universe'],
      };

      await supplierService.updateSupplier(supplierName, {
        supplierInfo: result,
        aliases: knownSupplier.aliases.length > 0 ? knownSupplier.aliases : undefined,
        categoryA: knownSupplier.categoryA || undefined,
      });

      return result;
    }

    // Universe match but sparse info — fall through to Exa + LLM research.
    // Universe metadata (aliases, type, categoryA) was already stored at import time.
  }

  // Get company context for research
  let companyContext;
  try {
    const metadata = await projectService.getMetadata();
    companyContext = metadata.companyContext ?? undefined;
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
  const { result } = await researchSupplier(supplierName, companyContext, address, searchResults);

  // Track that Exa was used as a source
  if (searchResults.length > 0 && !result.sources.includes('Exa Web Search')) {
    result.sources.push('Exa Web Search');
  }

  // Apply heuristic fallback if LLM didn't return supplierType
  if (!result.supplierType) {
    const heuristicType = determineSupplierType(result);
    if (heuristicType) result.supplierType = heuristicType;
  }

  // Store results
  await supplierService.updateSupplier(supplierName, {
    supplierInfo: result,
  });

  return result;
}

/**
 * Research multiple suppliers in parallel batches.
 * Accepts an optional `shouldCancel` callback to abort between batches.
 */
export async function researchBatch(
  supplierNames: string[],
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<void> {
  const BATCH_SIZE = 10;
  let done = 0;
  const total = supplierNames.length;

  // Filter out already-researched suppliers (1 bulk query instead of N sequential)
  const supplierMap = await supplierService.getSuppliersByNames(supplierNames);
  const toResearch: string[] = [];
  for (const name of supplierNames) {
    const supplier = supplierMap.get(name);
    const info = supplier?.supplierInfo;
    const hasSubstantiveInfo = !!(info?.industry || info?.description);
    if (!hasSubstantiveInfo) {
      toResearch.push(name);
    } else {
      done++;
    }
  }

  if (onProgress) onProgress(done, total);

  // Build matcher index once for the entire batch
  const universe = await readSupplierUniverse();
  const matcher = buildMatcherIndex(universe);

  // Process in batches — check cancellation between each batch
  for (let i = 0; i < toResearch.length; i += BATCH_SIZE) {
    if (shouldCancel?.()) return;

    const batch = toResearch.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (name) => {
      try {
        await researchSingle(name, matcher);
      } catch (error) {
        console.error(`[SupplierResearch] Failed to research ${name}:`, error);
      }
      done++;
      if (onProgress) onProgress(done, total);
    });
    await Promise.all(promises);
  }
}

/**
 * Heuristic fallback for determining supplier type from research results.
 * Used only when the LLM doesn't return an explicit supplierType.
 */
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
