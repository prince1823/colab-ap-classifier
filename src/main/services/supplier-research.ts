import { databaseService } from './database';
import { researchSupplier } from '../agents/research-agent';
import * as supplierService from './suppliers';
import * as projectService from './project';
import { searchSupplier, type ExaSearchResult } from './exa-search';
import type { SupplierInfo } from '../../shared/types';

/**
 * Research result returned by the research agent.
 * Extends SupplierInfo with confidence and sources.
 */
export interface SupplierResearchResult extends SupplierInfo {
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

// ---------------------------------------------------------------------------
// State (for progress streaming)
// ---------------------------------------------------------------------------

let mainWindowRef: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null = null;
let isCancelled = false;

export function setMainWindow(win: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null): void {
  mainWindowRef = win;
}

export function cancel(): void {
  isCancelled = true;
}

// ---------------------------------------------------------------------------
// Single supplier research
// ---------------------------------------------------------------------------

/**
 * Research a single supplier and store results in supplier_universe.db.
 */
export async function researchSingle(supplierName: string): Promise<SupplierResearchResult> {
  // Check if already researched with substantive info
  const existing = await supplierService.getSupplierByName(supplierName);
  if (existing?.supplierInfo) {
    const info = existing.supplierInfo;
    const hasSubstantiveInfo = !!(info.industry || info.description);
    if (hasSubstantiveInfo) {
      return {
        ...info,
        confidence: info.confidence ?? 'high',
        sources: info.sources ?? ['Existing research'],
      };
    }
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
  const address = existing?.supplierInfo?.supplierAddress;

  // Search Exa for web data (gracefully returns [] if unavailable)
  let searchResults: ExaSearchResult[] = [];
  try {
    searchResults = await searchSupplier(supplierName, address);
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

  // Store results in supplier_universe.db
  await supplierService.upsertSupplier(supplierName, {
    supplierInfo: result,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Batch research (step 6)
// ---------------------------------------------------------------------------

/**
 * Research all project suppliers.
 * Streams results as each supplier completes.
 * Skips already-researched suppliers.
 */
export async function researchAllProjectSuppliers(): Promise<void> {
  isCancelled = false;

  // Get distinct supplier names from transactions
  const supplierRows = await databaseService.all<{ supplier_name: string }>(
    `SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL ORDER BY supplier_name`
  );

  const supplierNames = supplierRows.map((r) => r.supplier_name);
  const total = supplierNames.length;
  let done = 0;

  // Filter out already-researched suppliers
  const toResearch: string[] = [];
  for (const name of supplierNames) {
    const existing = await supplierService.getSupplierByName(name);
    const info = existing?.supplierInfo;
    const hasSubstantiveInfo = !!(info?.industry || info?.description);
    if (!hasSubstantiveInfo) {
      toResearch.push(name);
    } else {
      done++;
    }
  }

  emitProgress(done, total, null, 'Starting research');

  // Research sequentially (simple, predictable — avoids rate limit complexity)
  for (const name of toResearch) {
    if (isCancelled) break;

    emitProgress(done, total, name, `Researching: ${name}`);

    try {
      await researchSingle(name);
    } catch (error) {
      console.error(`[SupplierResearch] Failed to research ${name}:`, error);
      // Still insert a thin row so we don't block classification entirely
      await supplierService.upsertSupplier(name, {
        supplierInfo: {
          confidence: 'low',
          sources: ['Research failed'],
        },
      });
    }

    done++;
    emitProgress(done, total, name, `Completed: ${name}`);
  }

  if (!isCancelled) {
    emitProgress(total, total, null, 'Research complete');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitProgress(done: number, total: number, currentSupplier: string | null, step: string): void {
  if (mainWindowRef) {
    mainWindowRef.webContents.send('suppliers:research:progress', {
      done,
      total,
      percentage: total > 0 ? Math.round((done / total) * 100) : 0,
      currentSupplier,
      step,
    });
  }
}

/**
 * Heuristic fallback for determining supplier type.
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
