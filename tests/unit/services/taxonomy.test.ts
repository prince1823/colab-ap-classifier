import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { databaseService } from '../../../src/main/services/database';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock the colabip service for importFromColabip tests
vi.mock('../../../src/main/services/colabip', () => ({
  readTaxonomy: vi.fn(),
}));

import {
  getTaxonomyMetadata,
  getNodes,
  setTaxonomy,
  importFromColabip,
} from '../../../src/main/services/taxonomy';
import { readTaxonomy } from '../../../src/main/services/colabip';

const mockedReadTaxonomy = vi.mocked(readTaxonomy);

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
  });

  afterEach(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('setTaxonomy', () => {
    it('should insert all nodes with correct depth and parent_path', async () => {
      await setTaxonomy({
        name: 'test-taxonomy',
        nodes: [
          { path: 'Direct', description: 'Direct spend' },
          { path: 'Direct|IT', description: 'IT spend' },
          { path: 'Direct|IT|Software', description: 'Software spend' },
          { path: 'Indirect', description: 'Indirect spend' },
          { path: 'Indirect|Facilities', description: 'Facilities' },
          { path: 'Exempt', description: 'Exempt spend' },
        ],
      });

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
      await setTaxonomy({
        name: 'test-taxonomy',
        nodes: [
          { path: 'Direct' },
          { path: 'Indirect' },
          { path: 'Exempt' },
        ],
      });

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
      await setTaxonomy({
        name: 'test-taxonomy',
        nodes: [{ path: 'Direct' }],
      });

      const nodes = await getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].description).toBeNull();
    });
  });

  describe('importFromColabip', () => {
    it('should import nodes from ColabIP service via setTaxonomy', async () => {
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

      // Verify metadata uses industry name
      const metadata = await getTaxonomyMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.name).toBe('test-industry');
      expect(metadata!.nodeCount).toBe(4);
    });
  });

  describe('depth validation', () => {
    it('should reject paths with depth greater than 3', async () => {
      await expect(
        setTaxonomy({
          name: 'bad-taxonomy',
          nodes: [{ path: 'Direct|IT|Software|Extra' }],
        })
      ).rejects.toThrow('depth must be 1, 2, or 3');
    });

    it('should accept any L1 value (no L1 constraint)', async () => {
      await setTaxonomy({
        name: 'healthcare-taxonomy',
        nodes: [
          { path: 'Clinical', description: 'Clinical costs' },
          { path: 'Non Clinical', description: 'Non-clinical costs' },
          { path: 'Non-Sourceable', description: 'Non-procurement items' },
        ],
      });

      const nodes = await getNodes();
      expect(nodes).toHaveLength(3);
      expect(nodes.map((n) => n.l1).sort()).toEqual(['Clinical', 'Non Clinical', 'Non-Sourceable']);
    });

    it('should not modify database when validation fails', async () => {
      // First set a valid taxonomy
      await setTaxonomy({
        name: 'valid-taxonomy',
        nodes: [{ path: 'Direct', description: 'Valid' }],
      });

      // Attempt to set a taxonomy with depth > 3
      await expect(
        setTaxonomy({
          name: 'invalid-taxonomy',
          nodes: [{ path: 'A|B|C|D' }],
        })
      ).rejects.toThrow('depth must be 1, 2, or 3');

      // The previous valid taxonomy should still be intact
      const nodes = await getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].fullPath).toBe('Direct');

      const metadata = await getTaxonomyMetadata();
      expect(metadata!.name).toBe('valid-taxonomy');
    });
  });

  describe('getTaxonomyMetadata', () => {
    it('should return null when no taxonomy has been set', async () => {
      const metadata = await getTaxonomyMetadata();
      expect(metadata).toBeNull();
    });

    it('should return correct name and count after setting taxonomy', async () => {
      await setTaxonomy({
        name: 'my-taxonomy',
        nodes: [
          { path: 'Direct', description: 'Direct' },
          { path: 'Direct|IT', description: 'IT' },
          { path: 'Indirect', description: 'Indirect' },
        ],
      });

      const metadata = await getTaxonomyMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.name).toBe('my-taxonomy');
      expect(metadata!.nodeCount).toBe(3);
    });
  });

  describe('replace taxonomy', () => {
    it('should remove old nodes when setting a new taxonomy', async () => {
      // Set first taxonomy
      await setTaxonomy({
        name: 'taxonomy-v1',
        nodes: [
          { path: 'Direct', description: 'Direct v1' },
          { path: 'Direct|IT', description: 'IT v1' },
          { path: 'Direct|IT|Software', description: 'Software v1' },
          { path: 'Indirect', description: 'Indirect v1' },
        ],
      });

      let nodes = await getNodes();
      expect(nodes).toHaveLength(4);

      // Replace with different taxonomy
      await setTaxonomy({
        name: 'taxonomy-v2',
        nodes: [
          { path: 'Exempt', description: 'Exempt v2' },
          { path: 'Exempt|Tax', description: 'Tax v2' },
        ],
      });

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
      const metadata = await getTaxonomyMetadata();
      expect(metadata!.name).toBe('taxonomy-v2');
      expect(metadata!.nodeCount).toBe(2);
    });
  });

  describe('duplicate path validation', () => {
    it('should reject duplicate paths in the input', async () => {
      await expect(
        setTaxonomy({
          name: 'dups',
          nodes: [
            { path: 'Direct', description: 'First' },
            { path: 'Direct', description: 'Duplicate' },
          ],
        })
      ).rejects.toThrow('Duplicate taxonomy path: "Direct"');
    });
  });

  describe('parent path validation', () => {
    it('should reject nodes whose parent path does not exist in the set', async () => {
      await expect(
        setTaxonomy({
          name: 'missing-parent',
          nodes: [
            { path: 'Direct|IT|Software', description: 'No parent' },
          ],
        })
      ).rejects.toThrow('Parent path "Direct|IT" not found');
    });

    it('should accept depth-2 node when depth-1 parent exists', async () => {
      await setTaxonomy({
        name: 'valid-parents',
        nodes: [
          { path: 'Direct', description: 'L1' },
          { path: 'Direct|IT', description: 'L2' },
        ],
      });

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
      await setTaxonomy({
        name: 'ordered',
        nodes: [
          { path: 'Indirect', description: 'Indirect' },
          { path: 'Direct', description: 'Direct' },
          { path: 'Direct|IT', description: 'IT' },
          { path: 'Exempt', description: 'Exempt' },
        ],
      });

      const nodes = await getNodes();
      const paths = nodes.map((n) => n.fullPath);
      expect(paths).toEqual(['Direct', 'Direct|IT', 'Exempt', 'Indirect']);
    });

    it('should include createdAt timestamp on each node', async () => {
      await setTaxonomy({
        name: 'timestamps',
        nodes: [{ path: 'Direct' }],
      });

      const nodes = await getNodes();
      expect(nodes[0].createdAt).toBeDefined();
      expect(nodes[0].createdAt).not.toBe('');
    });
  });
});
