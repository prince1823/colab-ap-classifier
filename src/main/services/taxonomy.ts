import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import type {
  Database,
  TaxonomyStore as ITaxonomyStore,
  ProjectStore as IProjectStore,
} from '../../shared/types/services';
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

export class TaxonomyStore implements ITaxonomyStore {
  constructor(
    private db: Database,
    private project: IProjectStore
  ) {}

  async getNodes(): Promise<TaxonomyNode[]> {
    const rows = await this.db.all<TaxonomyRow>(
      'SELECT id, full_path, l1, l2, l3, depth, description, parent_path, created_at FROM taxonomy ORDER BY full_path'
    );
    return rows.map(toTaxonomyNode);
  }

  async addNode(
    fullPath: string,
    description?: string
  ): Promise<TaxonomyNode> {
    const { l1, l2, l3, depth, parentPath } = parsePath(fullPath);

    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM taxonomy WHERE full_path = ?',
      fullPath
    );
    if (existing) {
      throw new Error(`Taxonomy node already exists: "${fullPath}"`);
    }

    if (parentPath) {
      const parent = await this.db.get<{ id: string }>(
        'SELECT id FROM taxonomy WHERE full_path = ?',
        parentPath
      );
      if (!parent) {
        throw new Error(`Parent path "${parentPath}" not found for node "${fullPath}"`);
      }
    }

    const id = uuidv4();
    await this.db.run(
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

  async updateNode(
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
    await this.db.run(
      `UPDATE taxonomy SET ${setClauses.join(', ')} WHERE id = ?`,
      ...params
    );
  }

  async deleteNode(nodeId: string, reassignTo?: string): Promise<void> {
    const node = await this.db.get<TaxonomyRow>(
      'SELECT * FROM taxonomy WHERE id = ?',
      nodeId
    );
    if (!node) {
      throw new Error(`Taxonomy node not found: ${nodeId}`);
    }

    const children = await this.db.all<{ id: string }>(
      'SELECT id FROM taxonomy WHERE parent_path = ?',
      node.full_path
    );
    if (children.length > 0) {
      throw new Error(`Cannot delete node "${node.full_path}": has ${children.length} child node(s)`);
    }

    if (reassignTo) {
      await this.db.run(
        'UPDATE transactions SET taxonomy_node_id = ? WHERE taxonomy_node_id = ?',
        reassignTo,
        nodeId
      );
    } else {
      const txns = await this.db.get<{ cnt: number | bigint }>(
        'SELECT COUNT(*) as cnt FROM transactions WHERE taxonomy_node_id = ?',
        nodeId
      );
      if (Number(txns?.cnt ?? 0) > 0) {
        throw new Error(
          `Cannot delete node "${node.full_path}": ${txns!.cnt} transaction(s) reference it`
        );
      }
    }

    await this.db.run('DELETE FROM taxonomy WHERE id = ?', nodeId);
  }

  async renameNode(nodeId: string, newName: string): Promise<void> {
    const node = await this.db.get<TaxonomyRow>(
      'SELECT * FROM taxonomy WHERE id = ?',
      nodeId
    );
    if (!node) {
      throw new Error(`Taxonomy node not found: ${nodeId}`);
    }

    const oldPath = node.full_path;
    const parts = oldPath.split('|');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('|');
    const parsed = parsePath(newPath);

    // Update the node itself
    await this.db.run(
      'UPDATE taxonomy SET full_path = ?, l1 = ?, l2 = ?, l3 = ? WHERE id = ?',
      newPath,
      parsed.l1,
      parsed.l2,
      parsed.l3,
      nodeId
    );

    // Cascade: update children whose parent_path starts with old path
    const children = await this.db.all<TaxonomyRow>(
      'SELECT * FROM taxonomy WHERE parent_path = ? OR parent_path LIKE ?',
      oldPath,
      `${oldPath}|%`
    );

    for (const child of children) {
      const newChildPath = child.full_path.replace(oldPath, newPath);
      const newChildParent = child.parent_path
        ? child.parent_path.replace(oldPath, newPath)
        : null;
      const childParsed = parsePath(newChildPath);

      await this.db.run(
        'UPDATE taxonomy SET full_path = ?, l1 = ?, l2 = ?, l3 = ?, parent_path = ? WHERE id = ?',
        newChildPath,
        childParsed.l1,
        childParsed.l2,
        childParsed.l3,
        newChildParent,
        child.id
      );
    }
  }

  async mergeNodes(sourceId: string, targetId: string): Promise<{ transactionsMoved: number }> {
    const source = await this.db.get<TaxonomyRow>(
      'SELECT * FROM taxonomy WHERE id = ?',
      sourceId
    );
    if (!source) throw new Error(`Source taxonomy node not found: ${sourceId}`);

    const target = await this.db.get<TaxonomyRow>(
      'SELECT * FROM taxonomy WHERE id = ?',
      targetId
    );
    if (!target) throw new Error(`Target taxonomy node not found: ${targetId}`);

    // Move transactions from source to target
    const countResult = await this.db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions WHERE taxonomy_node_id = ?',
      sourceId
    );
    const transactionsMoved = Number(countResult?.cnt ?? 0);

    if (transactionsMoved > 0) {
      await this.db.run(
        'UPDATE transactions SET taxonomy_node_id = ? WHERE taxonomy_node_id = ?',
        targetId,
        sourceId
      );
    }

    // Delete source node
    await this.db.run('DELETE FROM taxonomy WHERE id = ?', sourceId);

    return { transactionsMoved };
  }

  async importFromFile(filePath: string): Promise<{ nodeCount: number }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Taxonomy file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return this.createFromText(content);
  }

  async createFromText(text: string): Promise<{ nodeCount: number }> {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    const nodes: Array<{
      id: string;
      fullPath: string;
      l1: string;
      l2: string | null;
      l3: string | null;
      depth: number;
      description: string | null;
      parentPath: string | null;
    }> = [];

    for (const line of lines) {
      // Format: "path" or "path|description" (description after last pipe for leaf nodes is tricky)
      // Assume format: each line is a pipe-delimited taxonomy path
      const trimmedLine = line.replace(/^[-*]\s*/, '').trim(); // Strip markdown list prefixes
      if (!trimmedLine) continue;

      const { l1, l2, l3, depth, parentPath } = parsePath(trimmedLine);
      nodes.push({
        id: uuidv4(),
        fullPath: trimmedLine,
        l1,
        l2,
        l3,
        depth,
        description: null,
        parentPath,
      });
    }

    // Validate unique paths
    const pathSet = new Set<string>();
    for (const node of nodes) {
      if (pathSet.has(node.fullPath)) {
        throw new Error(`Duplicate taxonomy path: "${node.fullPath}"`);
      }
      pathSet.add(node.fullPath);
    }

    // Validate parent paths exist
    for (const node of nodes) {
      if (node.parentPath !== null && !pathSet.has(node.parentPath)) {
        throw new Error(
          `Parent path "${node.parentPath}" not found for node "${node.fullPath}"`
        );
      }
    }

    // Clear existing taxonomy
    await this.db.run('DELETE FROM taxonomy');

    // Insert all nodes
    for (const node of nodes) {
      await this.db.run(
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

    return { nodeCount: nodes.length };
  }
}
