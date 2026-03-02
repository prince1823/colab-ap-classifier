import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { databaseService } from '../../../src/main/services/database';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock the colabip service for importFromColabip tests
vi.mock('../../../src/main/services/colabip', () => ({
  readTaxonomy: vi.fn(),
}));

// Mock the project service for importFromColabip (calls updateMetadata)
vi.mock('../../../src/main/services/project', () => ({
  updateMetadata: vi.fn().mockResolvedValue(undefined),
}));

import {
  getNodes,
  addNode,
  updateNode,
  deleteNode,
  importFromColabip,
} from '../../../src/main/services/taxonomy';
import { readTaxonomy } from '../../../src/main/services/colabip';
import * as projectService from '../../../src/main/services/project';

const mockedReadTaxonomy = vi.mocked(readTaxonomy);
const mockedUpdateMetadata = vi.mocked(projectService.updateMetadata);

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `test-taxonomy-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`
  );
}

describe('TaxonomyService', () => {
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    await databaseService.openDatabase(dbPath);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('addNode', () => {
    it('should insert all nodes with correct depth and parent_path', async () => {
      await addNode('Direct', 'Direct spend');
      await addNode('Direct|IT', 'IT spend');
      await addNode('Direct|IT|Software', 'Software spend');
      await addNode('Indirect', 'Indirect spend');
      await addNode('Indirect|Facilities', 'Facilities');
      await addNode('Exempt', 'Exempt spend');

      const nodes = await getNodes();
      expect(nodes).toHaveLength(6);

      // Check depth-1 node
      const direct = nodes.find((n) => n.fullPath === 'Direct');
      expect(direct).toBeDefined();
      expect(direct!.l1).toBe('Direct');
      expect(direct!.l2).toBeNull();
      expect(direct!.l3).toBeNull();
      expect(direct!.depth).toBe(1);
      expect(direct!.parentPath).toBeNull();
      expect(direct!.description).toBe('Direct spend');

      // Check depth-2 node
      const it = nodes.find((n) => n.fullPath === 'Direct|IT');
      expect(it).toBeDefined();
      expect(it!.l1).toBe('Direct');
      expect(it!.l2).toBe('IT');
      expect(it!.l3).toBeNull();
      expect(it!.depth).toBe(2);
      expect(it!.parentPath).toBe('Direct');

      // Check depth-3 node
      const software = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
      expect(software).toBeDefined();
      expect(software!.l1).toBe('Direct');
      expect(software!.l2).toBe('IT');
      expect(software!.l3).toBe('Software');
      expect(software!.depth).toBe(3);
      expect(software!.parentPath).toBe('Direct|IT');

      // Check Indirect depth-2 node
      const facilities = nodes.find((n) => n.fullPath === 'Indirect|Facilities');
      expect(facilities).toBeDefined();
      expect(facilities!.l1).toBe('Indirect');
      expect(facilities!.l2).toBe('Facilities');
      expect(facilities!.depth).toBe(2);
      expect(facilities!.parentPath).toBe('Indirect');

      // Check Exempt depth-1 node
      const exempt = nodes.find((n) => n.fullPath === 'Exempt');
      expect(exempt).toBeDefined();
      expect(exempt!.depth).toBe(1);
      expect(exempt!.parentPath).toBeNull();
    });

    it('should generate unique UUIDs for each node', async () => {
      await addNode('Direct');
      await addNode('Indirect');
      await addNode('Exempt');

      const nodes = await getNodes();
      const ids = nodes.map((n) => n.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);

      // Verify UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const id of ids) {
        expect(id).toMatch(uuidRegex);
      }
    });

    it('should handle nodes with no description', async () => {
      await addNode('Direct');

      const nodes = await getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].description).toBeNull();
    });
  });

  describe('updateNode', () => {
    it('should update the description of an existing node', async () => {
      const node = await addNode('Direct', 'Original');

      await updateNode(node.id, { description: 'Updated' });

      const nodes = await getNodes();
      const updated = nodes.find((n) => n.id === node.id);
      expect(updated).toBeDefined();
      expect(updated!.description).toBe('Updated');
    });

    it('should no-op when no updates are provided', async () => {
      const node = await addNode('Direct', 'Original');

      await updateNode(node.id, {});

      const nodes = await getNodes();
      const same = nodes.find((n) => n.id === node.id);
      expect(same).toBeDefined();
      expect(same!.description).toBe('Original');
    });
  });

  describe('deleteNode', () => {
    it('should delete a leaf node', async () => {
      await addNode('Direct');
      const child = await addNode('Direct|IT');

      await deleteNode(child.id);

      const nodes = await getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].fullPath).toBe('Direct');
    });

    it('should throw when deleting a node with children', async () => {
      const parent = await addNode('Direct');
      await addNode('Direct|IT');

      await expect(deleteNode(parent.id)).rejects.toThrow('has 1 child node(s)');
    });

    it('should throw when node does not exist', async () => {
      await expect(deleteNode('nonexistent-id')).rejects.toThrow('Taxonomy node not found');
    });
  });

  describe('importFromColabip', () => {
    it('should import nodes from ColabIP and update project metadata', async () => {
      mockedReadTaxonomy.mockResolvedValue({
        nodes: [
          { path: 'Direct', description: 'Direct spend' },
          { path: 'Direct|IT', description: 'IT department' },
          { path: 'Direct|IT|Software', description: 'Software licenses' },
          { path: 'Indirect', description: 'Indirect spend' },
        ],
      });

      await importFromColabip('test-industry');

      expect(mockedReadTaxonomy).toHaveBeenCalledWith('test-industry');

      const nodes = await getNodes();
      expect(nodes).toHaveLength(4);

      const paths = nodes.map((n) => n.fullPath);
      expect(paths).toContain('Direct');
      expect(paths).toContain('Direct|IT');
      expect(paths).toContain('Direct|IT|Software');
      expect(paths).toContain('Indirect');

      // Verify project metadata was updated with the industry name
      expect(mockedUpdateMetadata).toHaveBeenCalledWith({ taxonomyName: 'test-industry' });
    });
  });

  describe('depth validation', () => {
    it('should reject paths with depth greater than 3', async () => {
      await expect(
        addNode('Direct|IT|Software|Extra')
      ).rejects.toThrow('depth must be 1, 2, or 3');
    });

    it('should accept any L1 value (no L1 constraint)', async () => {
      await addNode('Clinical', 'Clinical costs');
      await addNode('Non Clinical', 'Non-clinical costs');
      await addNode('Non-Sourceable', 'Non-procurement items');

      const nodes = await getNodes();
      expect(nodes).toHaveLength(3);
      expect(nodes.map((n) => n.l1).sort()).toEqual(['Clinical', 'Non Clinical', 'Non-Sourceable']);
    });

    it('should not modify database when validation fails', async () => {
      // First add a valid node
      await addNode('Direct', 'Valid');

      // Attempt to add a node with depth > 3
      await expect(
        addNode('A|B|C|D')
      ).rejects.toThrow('depth must be 1, 2, or 3');

      // The previous valid node should still be intact
      const nodes = await getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].fullPath).toBe('Direct');
    });
  });

  describe('replace taxonomy via importFromColabip', () => {
    it('should remove old nodes when importing a new taxonomy', async () => {
      // Seed initial nodes
      await addNode('Direct', 'Direct v1');
      await addNode('Direct|IT', 'IT v1');
      await addNode('Direct|IT|Software', 'Software v1');
      await addNode('Indirect', 'Indirect v1');

      let nodes = await getNodes();
      expect(nodes).toHaveLength(4);

      // Replace via importFromColabip
      mockedReadTaxonomy.mockResolvedValue({
        nodes: [
          { path: 'Exempt', description: 'Exempt v2' },
          { path: 'Exempt|Tax', description: 'Tax v2' },
        ],
      });

      await importFromColabip('taxonomy-v2');

      nodes = await getNodes();
      expect(nodes).toHaveLength(2);

      // Old nodes should be gone
      const paths = nodes.map((n) => n.fullPath);
      expect(paths).not.toContain('Direct');
      expect(paths).not.toContain('Direct|IT');
      expect(paths).not.toContain('Direct|IT|Software');
      expect(paths).not.toContain('Indirect');

      // New nodes should be present
      expect(paths).toContain('Exempt');
      expect(paths).toContain('Exempt|Tax');

      // Metadata should reflect the new taxonomy
      expect(mockedUpdateMetadata).toHaveBeenCalledWith({ taxonomyName: 'taxonomy-v2' });
    });
  });

  describe('duplicate path validation', () => {
    it('should reject duplicate paths', async () => {
      await addNode('Direct', 'First');

      await expect(
        addNode('Direct', 'Duplicate')
      ).rejects.toThrow('Taxonomy node already exists: "Direct"');
    });

    it('should reject duplicate paths in importFromColabip input', async () => {
      mockedReadTaxonomy.mockResolvedValue({
        nodes: [
          { path: 'Direct', description: 'First' },
          { path: 'Direct', description: 'Duplicate' },
        ],
      });

      await expect(
        importFromColabip('dups')
      ).rejects.toThrow('Duplicate taxonomy path: "Direct"');
    });
  });

  describe('parent path validation', () => {
    it('should reject nodes whose parent path does not exist in the database', async () => {
      await expect(
        addNode('Direct|IT|Software', 'No parent')
      ).rejects.toThrow('Parent path "Direct|IT" not found');
    });

    it('should reject nodes in importFromColabip whose parent path does not exist in the set', async () => {
      mockedReadTaxonomy.mockResolvedValue({
        nodes: [
          { path: 'Direct|IT|Software', description: 'No parent' },
        ],
      });

      await expect(
        importFromColabip('missing-parent')
      ).rejects.toThrow('Parent path "Direct|IT" not found');
    });

    it('should accept depth-2 node when depth-1 parent exists', async () => {
      await addNode('Direct', 'L1');
      await addNode('Direct|IT', 'L2');

      const nodes = await getNodes();
      expect(nodes).toHaveLength(2);
    });
  });

  describe('getNodes', () => {
    it('should return empty array when no taxonomy is set', async () => {
      const nodes = await getNodes();
      expect(nodes).toEqual([]);
    });

    it('should return nodes ordered by full_path', async () => {
      await addNode('Indirect', 'Indirect');
      await addNode('Direct', 'Direct');
      await addNode('Direct|IT', 'IT');
      await addNode('Exempt', 'Exempt');

      const nodes = await getNodes();
      const paths = nodes.map((n) => n.fullPath);
      expect(paths).toEqual(['Direct', 'Direct|IT', 'Exempt', 'Indirect']);
    });

    it('should include createdAt timestamp on each node', async () => {
      await addNode('Direct');

      const nodes = await getNodes();
      expect(nodes[0].createdAt).toBeDefined();
      expect(nodes[0].createdAt).not.toBe('');
    });
  });
});
