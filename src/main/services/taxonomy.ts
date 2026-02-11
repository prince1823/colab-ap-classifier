import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { readTaxonomy } from './colabip';
import type { TaxonomyNode, TaxonomyMetadata, TaxonomySetInput } from '../../shared/types';

interface TaxonomyRow {
  id: string;
  full_path: string;
  l1: string;
  l2: string | null;
  l3: string | null;
  depth: number;
  description: string | null;
  parent_path: string | null;
  created_at: string;
}

function toTaxonomyNode(row: TaxonomyRow): TaxonomyNode {
  return {
    id: row.id,
    fullPath: row.full_path,
    l1: row.l1,
    l2: row.l2,
    l3: row.l3,
    depth: row.depth,
    description: row.description,
    parentPath: row.parent_path,
    createdAt: String(row.created_at),
  };
}

/**
 * Parse a pipe-delimited path into its l1, l2, l3 components.
 * E.g., "Corporate Services|IT|Software" → { l1: "Corporate Services", l2: "IT", l3: "Software", depth: 3 }
 */
function parsePath(fullPath: string): {
  l1: string;
  l2: string | null;
  l3: string | null;
  depth: number;
  parentPath: string | null;
} {
  const parts = fullPath.split('|');
  const depth = parts.length;

  if (depth < 1 || depth > 3) {
    throw new Error(
      `Invalid taxonomy path "${fullPath}": depth must be 1, 2, or 3 (got ${depth})`
    );
  }

  const l1 = parts[0];
  const l2 = parts[1] ?? null;
  const l3 = parts[2] ?? null;

  let parentPath: string | null = null;
  if (depth === 2) {
    parentPath = l1;
  } else if (depth === 3) {
    parentPath = `${l1}|${l2}`;
  }

  return { l1, l2, l3, depth, parentPath };
}

/**
 * Get taxonomy metadata: name from settings + node count.
 */
export async function getTaxonomyMetadata(): Promise<TaxonomyMetadata | null> {
  const nameSetting = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'taxonomy_name'"
  );

  if (!nameSetting) {
    return null;
  }

  const countResult = await databaseService.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM taxonomy'
  );

  return {
    name: nameSetting.value,
    nodeCount: Number(countResult?.cnt ?? 0),
  };
}

/**
 * Get all taxonomy nodes from the database.
 */
export async function getNodes(): Promise<TaxonomyNode[]> {
  const rows = await databaseService.all<TaxonomyRow>(
    'SELECT id, full_path, l1, l2, l3, depth, description, parent_path, created_at FROM taxonomy ORDER BY full_path'
  );

  return rows.map(toTaxonomyNode);
}

/**
 * Replace the entire taxonomy with new nodes.
 *
 * 1. Clear existing taxonomy table
 * 2. Parse each node path, validate, and insert
 * 3. Update taxonomy_name in settings
 */
export async function setTaxonomy(input: TaxonomySetInput): Promise<void> {
  // Pre-validate all nodes before making any DB changes
  const parsed = input.nodes.map((node) => {
    const { l1, l2, l3, depth, parentPath } = parsePath(node.path);
    return {
      id: uuidv4(),
      fullPath: node.path,
      l1,
      l2,
      l3,
      depth,
      description: node.description ?? null,
      parentPath,
    };
  });

  // Validate unique full_path values
  const pathSet = new Set<string>();
  for (const node of parsed) {
    if (pathSet.has(node.fullPath)) {
      throw new Error(`Duplicate taxonomy path: "${node.fullPath}"`);
    }
    pathSet.add(node.fullPath);
  }

  // Validate parent paths exist
  for (const node of parsed) {
    if (node.parentPath !== null && !pathSet.has(node.parentPath)) {
      throw new Error(
        `Parent path "${node.parentPath}" not found for node "${node.fullPath}"`
      );
    }
  }

  // Clear existing taxonomy
  await databaseService.run('DELETE FROM taxonomy');

  // Insert all nodes
  for (const node of parsed) {
    await databaseService.run(
      'INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, description, parent_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      node.id,
      node.fullPath,
      node.l1,
      node.l2,
      node.l3,
      node.depth,
      node.description,
      node.parentPath
    );
  }

  // Update taxonomy_name in settings (upsert)
  const existing = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'taxonomy_name'"
  );

  if (existing) {
    await databaseService.run(
      "UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'taxonomy_name'",
      input.name
    );
  } else {
    await databaseService.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      'taxonomy_name',
      input.name
    );
  }
}

/**
 * Import taxonomy from ColabIP service by industry name.
 * Reads taxonomy nodes from the ColabIP file system and stores them in the database.
 */
export async function importFromColabip(industryName: string): Promise<void> {
  const { nodes } = await readTaxonomy(industryName);

  await setTaxonomy({
    name: industryName,
    nodes,
  });
}
