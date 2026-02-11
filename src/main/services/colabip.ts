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

/** Sort filenames numerically when possible (1.txt before 10.txt) */
function numericSort(a: string, b: string): number {
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  if (!isNaN(numA) && !isNaN(numB)) {
    return numA - numB;
  }
  return a.localeCompare(b);
}

/**
 * List available taxonomies from colabip/taxonomies/.
 * Returns industry folder names with .txt file counts.
 */
export async function listTaxonomies(): Promise<TaxonomyInfo[]> {
  const taxonomiesDir = path.join(basePath, 'taxonomies');
  try {
    const entries = await fs.readdir(taxonomiesDir, { withFileTypes: true });
    const results: TaxonomyInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(taxonomiesDir, entry.name);
        const files = await fs.readdir(dirPath);
        const txtCount = files.filter((f) => f.endsWith('.txt')).length;
        results.push({ name: entry.name, nodeCount: txtCount });
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
 * Read all taxonomy nodes from colabip/taxonomies/{industryName}/.
 * Each .txt file has 2 lines: line 1 = pipe-delimited path, line 2 = description.
 */
export async function readTaxonomy(
  industryName: string
): Promise<{ nodes: Array<{ path: string; description: string }> }> {
  const dirPath = path.join(basePath, 'taxonomies', industryName);
  const nodes: Array<{ path: string; description: string }> = [];

  try {
    const files = await fs.readdir(dirPath);
    const txtFiles = files.filter((f) => f.endsWith('.txt')).sort(numericSort);

    for (const file of txtFiles) {
      try {
        const content = await fs.readFile(path.join(dirPath, file), 'utf-8');
        const cleaned = stripBOM(content);
        const lines = cleaned.split('\n').map((l) => l.trim());

        if (!lines[0]) {
          console.warn(
            `[ColabIP] Skipping malformed taxonomy file: ${industryName}/${file}`
          );
          continue;
        }

        nodes.push({
          path: lines[0],
          description: lines[1] || '',
        });
      } catch (err) {
        console.warn(
          `[ColabIP] Error reading taxonomy file ${industryName}/${file}:`,
          err
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { nodes: [] };
    }
    throw error;
  }

  return { nodes };
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
