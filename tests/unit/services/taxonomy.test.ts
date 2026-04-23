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

    it('should unwrap CSV-quoted path lines whose values contain commas', async () => {
      const text = [
        'Direct|Aviation|Air Traffic Control',
        '"Direct|Equipment|Cabling, Cabling Supplies & Racks"',
        '"Indirect|Human Resources|Medical, Dental And Life Insurance"',
      ].join('\n');

      await store.createFromText(text);
      const nodes = await store.getNodes();

      const cabling = nodes.find(
        (n) => n.fullPath === 'Direct|Equipment|Cabling, Cabling Supplies & Racks'
      );
      expect(cabling).toBeDefined();
      expect(cabling!.l1).toBe('Direct');
      expect(cabling!.l3).toBe('Cabling, Cabling Supplies & Racks');

      const medical = nodes.find(
        (n) => n.fullPath === 'Indirect|Human Resources|Medical, Dental And Life Insurance'
      );
      expect(medical).toBeDefined();
      expect(medical!.l1).toBe('Indirect');

      // No stray quoted L1s leaked through
      expect(nodes.some((n) => n.l1.startsWith('"'))).toBe(false);
      expect(nodes.some((n) => (n.l3 ?? '').endsWith('"'))).toBe(false);
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

  describe('renameNode — supplier path cascade', () => {
    it('should cascade rename into mapped_taxonomy_paths', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      await store.addNode('Direct|IT|Software', 'Software');

      // Insert a project_supplier with mapped_taxonomy_paths
      await db.run(
        "INSERT INTO project_suppliers (id, supplier_name, mapped_taxonomy_paths) VALUES (?, ?, ?)",
        'sup-1', 'Acme Corp', JSON.stringify(['Direct|IT|Software', 'Direct|IT'])
      );

      // Rename L1 node
      const nodes = await store.getNodes();
      const directNode = nodes.find(n => n.fullPath === 'Direct')!;
      await store.renameNode(directNode.id, 'Indirect');

      // Verify mapped_taxonomy_paths updated
      const row = await db.get<{ mapped_taxonomy_paths: string }>(
        'SELECT mapped_taxonomy_paths FROM project_suppliers WHERE id = ?', 'sup-1'
      );
      const paths = JSON.parse(row!.mapped_taxonomy_paths);
      expect(paths).toEqual(['Indirect|IT|Software', 'Indirect|IT']);
    });

    it('should cascade rename into l1_l2_path', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      await store.addNode('Direct|IT|Software');

      // Insert a project_supplier with l1_l2_path
      await db.run(
        "INSERT INTO project_suppliers (id, supplier_name, l1_l2_path) VALUES (?, ?, ?)",
        'sup-2', 'Beta Inc', JSON.stringify(['Direct|IT'])
      );

      const nodes = await store.getNodes();
      const itNode = nodes.find(n => n.fullPath === 'Direct|IT')!;
      await store.renameNode(itNode.id, 'Engineering');

      const row = await db.get<{ l1_l2_path: string }>(
        'SELECT l1_l2_path FROM project_suppliers WHERE id = ?', 'sup-2'
      );
      const paths = JSON.parse(row!.l1_l2_path);
      expect(paths).toEqual(['Direct|Engineering']);
    });

    it('should not modify unrelated paths in mapped_taxonomy_paths', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      await store.addNode('Direct|IT|Software');
      await store.addNode('Indirect');
      await store.addNode('Indirect|HR');
      await store.addNode('Indirect|HR|Recruiting');

      await db.run(
        "INSERT INTO project_suppliers (id, supplier_name, mapped_taxonomy_paths) VALUES (?, ?, ?)",
        'sup-3', 'Gamma LLC', JSON.stringify(['Direct|IT|Software', 'Indirect|HR|Recruiting'])
      );

      const nodes = await store.getNodes();
      const directNode = nodes.find(n => n.fullPath === 'Direct')!;
      await store.renameNode(directNode.id, 'Primary');

      const row = await db.get<{ mapped_taxonomy_paths: string }>(
        'SELECT mapped_taxonomy_paths FROM project_suppliers WHERE id = ?', 'sup-3'
      );
      const paths = JSON.parse(row!.mapped_taxonomy_paths);
      expect(paths).toEqual(['Primary|IT|Software', 'Indirect|HR|Recruiting']);
    });

    it('mapped_taxonomy_paths stores path strings not node IDs', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      await store.addNode('Direct|IT|Software');

      const nodes = await store.getNodes();
      const softwareNode = nodes.find(n => n.fullPath === 'Direct|IT|Software')!;

      // Store paths as pipe-delimited strings (not UUIDs)
      await db.run(
        "INSERT INTO project_suppliers (id, supplier_name, mapped_taxonomy_paths) VALUES (?, ?, ?)",
        'sup-4', 'Delta Co', JSON.stringify(['Direct|IT|Software'])
      );

      const row = await db.get<{ mapped_taxonomy_paths: string }>(
        'SELECT mapped_taxonomy_paths FROM project_suppliers WHERE id = ?', 'sup-4'
      );
      const paths: string[] = JSON.parse(row!.mapped_taxonomy_paths);

      // Verify they are path strings, not UUIDs
      expect(paths[0]).toBe('Direct|IT|Software');
      expect(paths[0]).not.toBe(softwareNode.id);
      expect(paths[0]).toContain('|');
    });
  });

  describe('deleteNode — rule warning', () => {
    it('should return warning when override rules reference the node', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      const leaf = await store.addNode('Direct|IT|Software');

      // Insert an override rule targeting this node
      await db.run(
        "INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, is_active) VALUES (?, ?, ?, ?, ?)",
        'rule-1', 'Test Rule', '{"groupConnector":"AND","groups":[]}', leaf.id, true
      );

      const result = await store.deleteNode(leaf.id);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('1 override rule(s)');
    });

    it('should return no warnings when no rules reference the node', async () => {
      await store.addNode('Direct');
      await store.addNode('Direct|IT');
      const leaf = await store.addNode('Direct|IT|Software');

      const result = await store.deleteNode(leaf.id);
      expect(result.warnings).toBeUndefined();
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
