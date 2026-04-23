import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';
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

  async getNodeCount(): Promise<number> {
    const [row] = await this.db.all<{ cnt: number }>('SELECT COUNT(*) as cnt FROM taxonomy');
    return row?.cnt ?? 0;
  }

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

  async deleteNode(nodeId: string, reassignTo?: string): Promise<{ warnings?: string[] }> {
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

    const warnings: string[] = [];

    // Warn if override rules reference this node (don't block)
    const rules = await this.db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM override_rules WHERE target_taxonomy_node_id = ?',
      nodeId
    );
    if (Number(rules?.cnt ?? 0) > 0) {
      warnings.push(`${Number(rules!.cnt)} override rule(s) still reference this node — they will need to be updated`);
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
    return { warnings: warnings.length > 0 ? warnings : undefined };
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

    // Cascade: update mapped_taxonomy_paths on project_suppliers
    const suppliersWithPaths = await this.db.all<{ id: string; mapped_taxonomy_paths: string }>(
      'SELECT id, mapped_taxonomy_paths FROM project_suppliers WHERE mapped_taxonomy_paths IS NOT NULL'
    );
    for (const supplier of suppliersWithPaths) {
      const paths: string[] = JSON.parse(supplier.mapped_taxonomy_paths);
      let changed = false;
      const updated = paths.map(p => {
        if (p === oldPath || p.startsWith(oldPath + '|')) {
          changed = true;
          return newPath + p.slice(oldPath.length);
        }
        return p;
      });
      if (changed) {
        await this.db.run(
          'UPDATE project_suppliers SET mapped_taxonomy_paths = ? WHERE id = ?',
          JSON.stringify(updated), supplier.id
        );
      }
    }

    // Cascade: update l1_l2_path on project_suppliers
    const suppliersWithL1L2 = await this.db.all<{ id: string; l1_l2_path: string }>(
      'SELECT id, l1_l2_path FROM project_suppliers WHERE l1_l2_path IS NOT NULL'
    );
    for (const supplier of suppliersWithL1L2) {
      const paths: string[] = JSON.parse(supplier.l1_l2_path);
      let changed = false;
      const updated = paths.map(p => {
        if (p === oldPath || p.startsWith(oldPath + '|')) {
          changed = true;
          return newPath + p.slice(oldPath.length);
        }
        return p;
      });
      if (changed) {
        await this.db.run(
          'UPDATE project_suppliers SET l1_l2_path = ? WHERE id = ?',
          JSON.stringify(updated), supplier.id
        );
      }
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
      throw new Error(
        `Cannot merge — ${transactionsMoved} transaction(s) are classified under "${source.full_path}". Reassign them in Review first.`
      );
    }

    // Delete source node (safe — no transactions reference it)
    await this.db.run('DELETE FROM taxonomy WHERE id = ?', sourceId);

    return { transactionsMoved };
  }

  async importFromFile(filePath: string): Promise<{ nodeCount: number; fileName: string }> {
    let resolvedPath = filePath;

    if (!resolvedPath || resolvedPath.trim().length === 0) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win!, {
        title: 'Select Taxonomy File',
        filters: [
          { name: 'Text Files', extensions: ['txt', 'csv', 'tsv'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error('No file selected');
      }
      resolvedPath = result.filePaths[0];
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Taxonomy file not found: ${resolvedPath}`);
    }

    // Block import if any transactions are already classified
    const classified = await this.db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions WHERE taxonomy_node_id IS NOT NULL'
    );
    if (Number(classified?.cnt ?? 0) > 0) {
      throw new Error(
        `Cannot replace taxonomy — ${classified!.cnt} transaction(s) are already classified.`
      );
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const { nodeCount } = await this.createFromText(content);
    const fileName = path.basename(resolvedPath, path.extname(resolvedPath));
    return { nodeCount, fileName };
  }

  async createFromText(text: string): Promise<{ nodeCount: number }> {
    const rawLines = text.split('\n');

    // Phase 1: Parse path + description pairs
    // Format: path line followed by optional tab-indented description line
    const explicit: Array<{ fullPath: string; description: string | null }> = [];

    for (const raw of rawLines) {
      if (raw.length === 0 || raw.trim().length === 0) continue;

      // Description line: starts with tab or leading whitespace
      if (/^\s/.test(raw)) {
        if (explicit.length > 0) {
          explicit[explicit.length - 1].description = raw.trim();
        }
        continue;
      }

      // Path line: strip markdown list prefixes
      let trimmed = raw.replace(/^[-*]\s*/, '').trim();
      // Unwrap CSV-style quoting (exporters wrap values containing commas in double quotes,
      // escaping embedded quotes by doubling them)
      if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        trimmed = trimmed.slice(1, -1).replace(/""/g, '"');
      }
      if (!trimmed) continue;

      const { depth } = parsePath(trimmed);
      if (depth !== 3) {
        throw new Error(
          `Invalid taxonomy path "${trimmed}": all paths must have exactly 3 levels (L1|L2|L3), got ${depth}`
        );
      }

      explicit.push({ fullPath: trimmed, description: null });
    }

    // Phase 2: Validate no duplicate paths
    const pathSet = new Set<string>();
    for (const entry of explicit) {
      if (pathSet.has(entry.fullPath)) {
        throw new Error(`Duplicate taxonomy path: "${entry.fullPath}"`);
      }
      pathSet.add(entry.fullPath);
    }

    // Phase 3: Auto-generate missing parent nodes (L1, L2)
    const parentPaths = new Set<string>();
    for (const entry of explicit) {
      const parts = entry.fullPath.split('|');
      const l1 = parts[0];
      const l2 = `${parts[0]}|${parts[1]}`;
      if (!pathSet.has(l1)) parentPaths.add(l1);
      if (!pathSet.has(l2)) parentPaths.add(l2);
    }

    // Phase 4: Build final node list — L1 first, then L2, then L3
    type NodeEntry = {
      id: string;
      fullPath: string;
      l1: string;
      l2: string | null;
      l3: string | null;
      depth: number;
      description: string | null;
      parentPath: string | null;
    };

    const nodes: NodeEntry[] = [];

    // Add auto-generated parents sorted by depth
    const sortedParents = [...parentPaths].sort((a, b) => {
      const dA = a.split('|').length;
      const dB = b.split('|').length;
      return dA - dB || a.localeCompare(b);
    });

    for (const pp of sortedParents) {
      const parsed = parsePath(pp);
      nodes.push({
        id: uuidv4(),
        fullPath: pp,
        l1: parsed.l1,
        l2: parsed.l2,
        l3: parsed.l3,
        depth: parsed.depth,
        description: null,
        parentPath: parsed.parentPath,
      });
    }

    // Add explicit L3 nodes
    for (const entry of explicit) {
      const parsed = parsePath(entry.fullPath);
      nodes.push({
        id: uuidv4(),
        fullPath: entry.fullPath,
        l1: parsed.l1,
        l2: parsed.l2,
        l3: parsed.l3,
        depth: parsed.depth,
        description: entry.description,
        parentPath: parsed.parentPath,
      });
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
