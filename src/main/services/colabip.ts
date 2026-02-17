import path from 'path';
import fs from 'fs/promises';
import { parse } from 'csv-parse/sync';
import type { TaxonomyInfo, RulePackInfo, RuleCondition } from '../../shared/types';

// Configurable base path — defaults to colabip/ in project root
let basePath = path.join(process.cwd(), 'colabip');

export function setColabipBasePath(p: string): void {
  basePath = p;
}

export function getColabipBasePath(): string {
  return basePath;
}

function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

/**
 * List available taxonomies from colabip/taxonomies/.
 * Returns industry folder names with leaf node counts (lines in taxonomy.txt).
 */
export async function listTaxonomies(): Promise<TaxonomyInfo[]> {
  const taxonomiesDir = path.join(basePath, 'taxonomies');
  try {
    const entries = await fs.readdir(taxonomiesDir, { withFileTypes: true });
    const results: TaxonomyInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const filePath = path.join(taxonomiesDir, entry.name, 'taxonomy.txt');
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const cleaned = stripBOM(content);
          const pathLines = cleaned.split('\n').filter((l) => l.trim() && !l.startsWith('\t'));
          results.push({ name: entry.name, nodeCount: pathLines.length });
        } catch {
          // No taxonomy.txt in this directory — skip
        }
      }
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * List available rule packs from colabip/taxonomies/{industry}/rules.csv.
 * Returns industry names with rule counts.
 */
export async function listRulePacks(): Promise<RulePackInfo[]> {
  const taxonomiesDir = path.join(basePath, 'taxonomies');
  try {
    const entries = await fs.readdir(taxonomiesDir, { withFileTypes: true });
    const results: RulePackInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const rulesPath = path.join(taxonomiesDir, entry.name, 'rules.csv');
        try {
          const content = await fs.readFile(rulesPath, 'utf-8');
          const cleaned = stripBOM(content);
          const records = parse(cleaned, {
            columns: true,
            skip_empty_lines: true,
          });
          results.push({ name: entry.name, ruleCount: records.length });
        } catch {
          // No rules.csv in this directory — skip
        }
      }
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Read all taxonomy nodes from colabip/taxonomies/{industryName}/taxonomy.txt.
 * Format: path line followed by tab-indented description line, e.g.:
 *   L1|L2|L3
 *   \tdescription text
 * Parent nodes (L1 and L1|L2) are auto-generated from leaf paths.
 */
export async function readTaxonomy(
  industryName: string
): Promise<{ nodes: Array<{ path: string; description: string }> }> {
  const filePath = path.join(basePath, 'taxonomies', industryName, 'taxonomy.txt');

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const cleaned = stripBOM(content);
    const lines = cleaned.split('\n');

    const parentPaths = new Map<string, true>();
    const nodes: Array<{ path: string; description: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip empty lines and tab-indented description lines (handled with their path)
      if (!line.trim() || line.startsWith('\t')) continue;

      const leafPath = line.trim();
      const parts = leafPath.split('|');
      if (parts.length !== 3) {
        console.warn(
          `[ColabIP] Skipping non-depth-3 line in ${industryName}/taxonomy.txt: "${leafPath}"`
        );
        continue;
      }

      // Next line is the tab-indented description (if present)
      let description = '';
      if (i + 1 < lines.length && lines[i + 1].startsWith('\t')) {
        description = lines[i + 1].trim();
        i++; // skip the description line
      }

      // Collect parent paths for auto-generation
      const l1 = parts[0];
      const l1l2 = `${parts[0]}|${parts[1]}`;
      parentPaths.set(l1, true);
      parentPaths.set(l1l2, true);

      nodes.push({ path: leafPath, description });
    }

    // Auto-generate parent nodes (L1 and L2) with no descriptions
    const parentNodes: Array<{ path: string; description: string }> = [];
    for (const parentPath of parentPaths.keys()) {
      parentNodes.push({ path: parentPath, description: '' });
    }

    return { nodes: [...parentNodes, ...nodes] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { nodes: [] };
    }
    throw error;
  }
}

/**
 * Read override rules from colabip/taxonomies/{industryName}/rules.csv.
 * CSV columns: name, conditions (JSON string), target_taxonomy_path, priority_score.
 */
export async function readRulePack(
  industryName: string
): Promise<
  Array<{
    name: string;
    conditions: RuleCondition[];
    targetPath: string;
    priorityScore: number;
  }>
> {
  const rulesPath = path.join(
    basePath,
    'taxonomies',
    industryName,
    'rules.csv'
  );

  try {
    const content = await fs.readFile(rulesPath, 'utf-8');
    const cleaned = stripBOM(content);
    const records = parse(cleaned, {
      columns: true,
      skip_empty_lines: true,
    }) as Record<string, string>[];

    const results: Array<{
      name: string;
      conditions: RuleCondition[];
      targetPath: string;
      priorityScore: number;
    }> = [];

    for (const record of records) {
      try {
        results.push({
          name: record.name || '',
          conditions: JSON.parse(record.conditions || '[]') as RuleCondition[],
          targetPath: record.target_taxonomy_path || '',
          priorityScore: parseInt(record.priority_score, 10) || 0,
        });
      } catch (err) {
        console.warn(
          `[ColabIP] Skipping malformed rule in ${industryName}/rules.csv:`,
          err
        );
      }
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Read the supplier universe from colabip/suppliers/supplier_universe.csv.
 */
export async function readSupplierUniverse(): Promise<
  Array<{
    supplierName: string;
    parentCompany: string;
    supplierType: string;
    website: string;
    industry: string;
  }>
> {
  const csvPath = path.join(basePath, 'suppliers', 'supplier_universe.csv');

  try {
    const content = await fs.readFile(csvPath, 'utf-8');
    const cleaned = stripBOM(content);
    const records = parse(cleaned, {
      columns: true,
      skip_empty_lines: true,
    }) as Record<string, string>[];

    return records.map((record) => ({
      supplierName: record.supplier_name || '',
      parentCompany: record.parent_company || '',
      supplierType: record.supplier_type || '',
      website: record.website || '',
      industry: record.industry || '',
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
