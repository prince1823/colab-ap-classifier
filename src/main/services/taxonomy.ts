import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { readTaxonomy } from './colabip';
import * as projectService from './project';
import type { TaxonomyNode } from '../../shared/types';

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

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get all taxonomy nodes from the database.
 */
export async function getNodes(): Promise<TaxonomyNode[]> {
  const rows = await databaseService.all<TaxonomyRow>(
    'SELECT id, full_path, l1, l2, l3, depth, description, parent_path, created_at FROM taxonomy ORDER BY full_path'
  );

  return rows.map(toTaxonomyNode);
}

// ---------------------------------------------------------------------------
// CRUD — step 9 node operations
// ---------------------------------------------------------------------------

/**
 * Add a single taxonomy node.
 * Validates depth and checks for duplicate full_path.
 */
export async function addNode(
  fullPath: string,
  description?: string
): Promise<TaxonomyNode> {
  const { l1, l2, l3, depth, parentPath } = parsePath(fullPath);

  // Check for duplicate
  const existing = await databaseService.get<{ id: string }>(
    'SELECT id FROM taxonomy WHERE full_path = ?',
    fullPath
  );
  if (existing) {
    throw new Error(`Taxonomy node already exists: "${fullPath}"`);
  }

  // Validate parent exists (if depth > 1)
  if (parentPath) {
    const parent = await databaseService.get<{ id: string }>(
      'SELECT id FROM taxonomy WHERE full_path = ?',
      parentPath
    );
    if (!parent) {
      throw new Error(`Parent path "${parentPath}" not found for node "${fullPath}"`);
    }
  }

  const id = uuidv4();
  await databaseService.run(
    'INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, description, parent_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    fullPath,
    l1,
    l2,
    l3,
    depth,
    description ?? null,
    parentPath
  );

  return {
    id,
    fullPath,
    l1,
    l2,
    l3,
    depth,
    description: description ?? null,
    parentPath,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Update a taxonomy node's description.
 * Path changes are not supported (would require cascading updates to children + transactions).
 */
export async function updateNode(
  nodeId: string,
  updates: { description?: string }
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    params.push(updates.description);
  }

  if (setClauses.length === 0) return;

  params.push(nodeId);
  await databaseService.run(
    `UPDATE taxonomy SET ${setClauses.join(', ')} WHERE id = ?`,
    ...params
  );
}

/**
 * Delete a taxonomy node.
 * Fails if any transactions reference this node or if child nodes exist.
 */
export async function deleteNode(nodeId: string): Promise<void> {
  // Check if node exists
  const node = await databaseService.get<TaxonomyRow>(
    'SELECT * FROM taxonomy WHERE id = ?',
    nodeId
  );
  if (!node) {
    throw new Error(`Taxonomy node not found: ${nodeId}`);
  }

  // Check for child nodes
  const children = await databaseService.all<{ id: string }>(
    'SELECT id FROM taxonomy WHERE parent_path = ?',
    node.full_path
  );
  if (children.length > 0) {
    throw new Error(`Cannot delete node "${node.full_path}": has ${children.length} child node(s)`);
  }

  // Check for transactions referencing this node
  const txns = await databaseService.get<{ cnt: number | bigint }>(
    'SELECT COUNT(*) as cnt FROM transactions WHERE taxonomy_node_id = ?',
    nodeId
  );
  if (Number(txns?.cnt ?? 0) > 0) {
    throw new Error(
      `Cannot delete node "${node.full_path}": ${txns!.cnt} transaction(s) reference it`
    );
  }

  await databaseService.run('DELETE FROM taxonomy WHERE id = ?', nodeId);
}

// ---------------------------------------------------------------------------
// Import from ColabIP
// ---------------------------------------------------------------------------

/**
 * Import taxonomy from ColabIP by industry name.
 * Replaces the project taxonomy and updates taxonomy_name in project metadata.
 */
export async function importFromColabip(industryName: string): Promise<void> {
  const { nodes } = await readTaxonomy(industryName);

  // Pre-validate all nodes
  const parsed = nodes.map((node) => {
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

  // TODO: taxonomy_name removed from project settings — re-evaluate if needed
  // await projectService.updateMetadata({ taxonomyName: industryName });
}
