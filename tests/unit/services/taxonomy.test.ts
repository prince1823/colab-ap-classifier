import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuckDBDatabase } from '../../../src/main/services/database';
import { TaxonomyStore } from '../../../src/main/services/taxonomy';
import { createMockProjectStore } from '../../helpers/mock-services';
import type { ProjectStore } from '../../../src/shared/types/services';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `test-taxonomy-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`
  );
}

describe('TaxonomyStore', () => {
  let dbPath: string;
  let db: DuckDBDatabase;
  let project: ProjectStore;
  let store: TaxonomyStore;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = new DuckDBDatabase();
    project = createMockProjectStore();
    await db.openDatabase(dbPath);
    store = new TaxonomyStore(db, project);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (db.isOpen()) {
      await db.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('addNode', () => {
    it('should insert all nodes with correct depth and parent_path', async () => {
      await store.addNode('Direct', 'Direct spend');
      await store.addNode('Direct|IT', 'IT spend');
      await store.addNode('Direct|IT|Software', 'Software spend');
      await store.addNode('Indirect', 'Indirect spend');
      await store.addNode('Indirect|Facilities', 'Facilities');
      await store.addNode('Exempt', 'Exempt spend');

      const nodes = await store.getNodes();
      expect(nodes).toHaveLength(6);

      const direct = nodes.find((n) => n.fullPath === 'Direct');
      expect(direct).toBeDefined();
      expect(direct!.l1).toBe('Direct');
      expect(direct!.l2).toBeNull();
      expect(direct!.l3).toBeNull();
      expect(direct!.depth).toBe(1);
      expect(direct!.parentPath).toBeNull();
      expect(direct!.description).toBe('Direct spend');

      const it_ = nodes.find((n) => n.fullPath === 'Direct|IT');
      expect(it_).toBeDefined();
      expect(it_!.depth).toBe(2);
      expect(it_!.parentPath).toBe('Direct');

      const software = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
      expect(software).toBeDefined();
      expect(software!.depth).toBe(3);
      expect(software!.parentPath).toBe('Direct|IT');
    });

    it('should generate unique UUIDs for each node', async () => {
      await store.addNode('Direct');
      await store.addNode('Indirect');
      await store.addNode('Exempt');

      const nodes = await store.getNodes();
      const ids = nodes.map((n) => n.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });

    it('should handle nodes with no description', async () => {
      await store.addNode('Direct');

      const nodes = await store.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].description).toBeNull();
    });
  });

  describe('updateNode', () => {
    it('should update the description of an existing node', async () => {
      const node = await store.addNode('Direct', 'Original');
      await store.updateNode(node.id, { description: 'Updated' });

      const nodes = await store.getNodes();
      const updated = nodes.find((n) => n.id === node.id);
      expect(updated!.description).toBe('Updated');
    });

    it('should no-op when no updates are provided', async () => {
      const node = await store.addNode('Direct', 'Original');
      await store.updateNode(node.id, {});

      const nodes = await store.getNodes();
      expect(nodes.find((n) => n.id === node.id)!.description).toBe('Original');
    });
  });

  describe('deleteNode', () => {
    it('should delete a leaf node', async () => {
      await store.addNode('Direct');
      const child = await store.addNode('Direct|IT');

      await store.deleteNode(child.id);

      const nodes = await store.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].fullPath).toBe('Direct');
    });

    it('should throw when deleting a node with children', async () => {
      const parent = await store.addNode('Direct');
      await store.addNode('Direct|IT');

      await expect(store.deleteNode(parent.id)).rejects.toThrow('has 1 child node(s)');
    });

    it('should throw when node does not exist', async () => {
      await expect(store.deleteNode('nonexistent-id')).rejects.toThrow('Taxonomy node not found');
    });
  });

  describe('depth validation', () => {
    it('should reject paths with depth greater than 3', async () => {
      await expect(store.addNode('Direct|IT|Software|Extra')).rejects.toThrow('depth must be 1, 2, or 3');
    });

    it('should accept any L1 value', async () => {
      await store.addNode('Clinical', 'Clinical costs');
      await store.addNode('Non Clinical', 'Non-clinical costs');

      const nodes = await store.getNodes();
      expect(nodes).toHaveLength(2);
    });
  });

  describe('duplicate path validation', () => {
    it('should reject duplicate paths', async () => {
      await store.addNode('Direct', 'First');
      await expect(store.addNode('Direct', 'Duplicate')).rejects.toThrow('Taxonomy node already exists: "Direct"');
    });
  });

  describe('parent path validation', () => {
    it('should reject nodes whose parent path does not exist', async () => {
      await expect(store.addNode('Direct|IT|Software', 'No parent')).rejects.toThrow('Parent path "Direct|IT" not found');
    });

    it('should accept depth-2 node when depth-1 parent exists', async () => {
      await store.addNode('Direct', 'L1');
      await store.addNode('Direct|IT', 'L2');

      const nodes = await store.getNodes();
      expect(nodes).toHaveLength(2);
    });
  });

  describe('createFromText', () => {
    it('should parse path + tab-indented description format', async () => {
      const text = [
        'Direct|IT|Software',
        '\tSoftware licenses and SaaS subscriptions',
        'Direct|IT|Hardware',
        '\tComputers, servers, and networking equipment',
      ].join('\n');

      const result = await store.createFromText(text);
      const nodes = await store.getNodes();

      // 2 explicit L3 + auto-generated: Direct (L1), Direct|IT (L2) = 4
      expect(result.nodeCount).toBe(4);

      const software = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
      expect(software).toBeDefined();
      expect(software!.description).toBe('Software licenses and SaaS subscriptions');
      expect(software!.depth).toBe(3);

      const hardware = nodes.find((n) => n.fullPath === 'Direct|IT|Hardware');
      expect(hardware!.description).toBe('Computers, servers, and networking equipment');
    });

    it('should auto-generate missing L1 and L2 parent nodes', async () => {
      const text = 'Clinical|Equipment|X-Ray\n\tX-ray machines';
      await store.createFromText(text);
      const nodes = await store.getNodes();

      const l1 = nodes.find((n) => n.fullPath === 'Clinical');
      expect(l1).toBeDefined();
      expect(l1!.depth).toBe(1);
      expect(l1!.description).toBeNull();
      expect(l1!.parentPath).toBeNull();

      const l2 = nodes.find((n) => n.fullPath === 'Clinical|Equipment');
      expect(l2).toBeDefined();
      expect(l2!.depth).toBe(2);
      expect(l2!.description).toBeNull();
      expect(l2!.parentPath).toBe('Clinical');
    });

    it('should not duplicate auto-generated parents across sibling L3 nodes', async () => {
      const text = [
        'Direct|IT|Software',
        'Direct|IT|Hardware',
        'Direct|HR|Recruiting',
      ].join('\n');

      await store.createFromText(text);
      const nodes = await store.getNodes();

      // L1: Direct (1), L2: Direct|IT, Direct|HR (2), L3: 3 = 6 total
      expect(nodes).toHaveLength(6);
      const directNodes = nodes.filter((n) => n.fullPath === 'Direct');
      expect(directNodes).toHaveLength(1);
    });

    it('should reject L1-only paths', async () => {
      await expect(store.createFromText('Direct')).rejects.toThrow(
        'all paths must have exactly 3 levels'
      );
    });

    it('should reject L2-only paths', async () => {
      await expect(store.createFromText('Direct|IT')).rejects.toThrow(
        'all paths must have exactly 3 levels'
      );
    });

    it('should reject paths with depth > 3', async () => {
      await expect(store.createFromText('A|B|C|D')).rejects.toThrow(
        'depth must be 1, 2, or 3'
      );
    });

    it('should reject duplicate paths', async () => {
      const text = 'Direct|IT|Software\nDirect|IT|Software';
      await expect(store.createFromText(text)).rejects.toThrow(
        'Duplicate taxonomy path'
      );
    });

    it('should handle paths without descriptions', async () => {
      const text = 'Direct|IT|Software\nDirect|IT|Hardware';
      await store.createFromText(text);
      const nodes = await store.getNodes();
      const software = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
      expect(software!.description).toBeNull();
    });

    it('should load fixture file via importFromFile', async () => {
      const fixturePath = path.join(
        __dirname, '..', '..', 'fixtures', 'colabip', 'taxonomies', 'general', 'taxonomy.txt'
      );
      const result = await store.importFromFile(fixturePath);
      expect(result.nodeCount).toBeGreaterThan(0);

      const nodes = await store.getNodes();
      const l3Nodes = nodes.filter((n) => n.depth === 3);
      // All L3 nodes from fixture should have descriptions
      for (const n of l3Nodes) {
        expect(n.description).not.toBeNull();
      }
    });
  });

  describe('getNodes', () => {
    it('should return empty array when no taxonomy is set', async () => {
      const nodes = await store.getNodes();
      expect(nodes).toEqual([]);
    });

    it('should return nodes ordered by full_path', async () => {
      await store.addNode('Indirect', 'Indirect');
      await store.addNode('Direct', 'Direct');
      await store.addNode('Direct|IT', 'IT');
      await store.addNode('Exempt', 'Exempt');

      const nodes = await store.getNodes();
      const paths = nodes.map((n) => n.fullPath);
      expect(paths).toEqual(['Direct', 'Direct|IT', 'Exempt', 'Indirect']);
    });

    it('should include createdAt timestamp on each node', async () => {
      await store.addNode('Direct');

      const nodes = await store.getNodes();
      expect(nodes[0].createdAt).toBeDefined();
      expect(nodes[0].createdAt).not.toBe('');
    });
  });
});
