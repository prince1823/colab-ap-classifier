import { researchSupplier } from '../agents/research-agent';
import { readSupplierUniverse } from './colabip';
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

  // Research via LLM
  const result = await researchSupplier(supplierName, companyContext, address);

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
