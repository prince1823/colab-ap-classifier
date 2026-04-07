/**
 * Tests for Cat A IPC handler changes:
 * - rules:setCategoryA writes to project supplier (not universe)
 * - rules:delete cascade writes to project supplier (not universe)
 * Uses getProjectSupplierByName (not listProjectSuppliers) via syncCatAState helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Capture IPC handler registrations ─────────────────────────────────
const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
}));

import { registerRulesHandlers } from '../../../src/main/ipc/rules';
import {
  createMockRuleStore,
  createMockSupplierService,
  createMockTaxonomyStore,
} from '../../helpers/mock-services';
import type { RuleStore, SupplierService, TaxonomyStore } from '../../../src/shared/types/services';
import type { OverrideRule } from '../../../src/shared/types/rules';
import type { TaxonomyNode } from '../../../src/shared/types/taxonomy';

const makeNode = (fullPath: string, id = fullPath): TaxonomyNode => ({
  id,
  fullPath,
  l1: fullPath.split('|')[0],
  l2: fullPath.split('|')[1] ?? null,
  l3: fullPath.split('|')[2] ?? null,
  depth: fullPath.split('|').length,
  description: null,
  parentPath: fullPath.split('|').slice(0, -1).join('|') || null,
  createdAt: '',
});

const taxonomyNodes: TaxonomyNode[] = [
  makeNode('Corporate Services|IT|Software', 'node-it-sw'),
  makeNode('Professional Services|Consulting|Strategy', 'node-consulting'),
];

function makeCatARule(overrides: Partial<OverrideRule> = {}): OverrideRule {
  return {
    id: 'rule-1',
    name: '[Cat A] Acme',
    groupedConditions: {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
      }],
    },
    targetTaxonomyNodeId: 'node-it-sw',
    groupId: null,
    isActive: true,
    source: 'supplier_universe',
    categoryASupplier: true,
    createdAt: '',
    ...overrides,
  };
}

function makeProjectSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sup-1',
    supplierName: 'Acme',
    confirmationStatus: 'pending',
    isTailSpend: false,
    parentSupplierId: null,
    parentName: null,
    supplierInfo: null,
    mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
    l1L2Path: null,
    universeMatch: false,
    isResearched: true,
    categoryASupplier: true,
    createdAt: '',
    transactionCount: 5,
    totalSpend: 1000,
    aliases: [],
    ...overrides,
  };
}

describe('rules IPC handlers — Cat A (project-only writes)', () => {
  let rules: RuleStore;
  let suppliers: SupplierService;
  let taxonomy: TaxonomyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    rules = createMockRuleStore();
    suppliers = createMockSupplierService();
    taxonomy = createMockTaxonomyStore();

    vi.mocked(taxonomy.getNodes).mockResolvedValue(taxonomyNodes);

    registerRulesHandlers(rules, suppliers, taxonomy);
  });

  // ─── rules:setCategoryA ──────────────────────────────────────────────────────

  describe('rules:setCategoryA', () => {
    it('updates rule and project supplier flag + mappedTaxonomyPaths when enabling', async () => {
      const rule = makeCatARule({ categoryASupplier: false });
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      const projectSupplier = makeProjectSupplier({
        categoryASupplier: false,
        mappedTaxonomyPaths: [],
      });
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(projectSupplier as any);

      const handler = handlers.get('rules:setCategoryA')!;
      await handler({}, 'rule-1', true);

      // Rule updated
      expect(rules.updateRule).toHaveBeenCalledWith('rule-1', { categoryASupplier: true });

      // Project supplier flag updated
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', { categoryASupplier: true });

      // Project supplier mappedTaxonomyPaths updated with node.fullPath
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', {
        mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
      });
    });

    it('removes path from project supplier mappedTaxonomyPaths when disabling', async () => {
      const rule = makeCatARule({ categoryASupplier: true });
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      const projectSupplier = makeProjectSupplier({
        categoryASupplier: true,
        mappedTaxonomyPaths: ['Corporate Services|IT|Software', 'Some|Other|Path'],
      });
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(projectSupplier as any);

      const handler = handlers.get('rules:setCategoryA')!;
      await handler({}, 'rule-1', false);

      // Rule updated
      expect(rules.updateRule).toHaveBeenCalledWith('rule-1', { categoryASupplier: false });

      // Project supplier flag cleared
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', { categoryASupplier: false });

      // Only the matching path removed
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', {
        mappedTaxonomyPaths: ['Some|Other|Path'],
      });
    });

    it('does not duplicate path if already present when enabling', async () => {
      const rule = makeCatARule({ categoryASupplier: false });
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      const projectSupplier = makeProjectSupplier({
        categoryASupplier: false,
        mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
      });
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(projectSupplier as any);

      const handler = handlers.get('rules:setCategoryA')!;
      await handler({}, 'rule-1', true);

      // Path already present — should not duplicate
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', {
        mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
      });
    });

    it('returns error when rule has no supplier_name condition', async () => {
      const rule = makeCatARule({
        groupedConditions: {
          groupConnector: 'AND',
          groups: [{ connector: 'AND', conditions: [{ field: 'gl_description', operator: 'contains', value: 'test' }] }],
        },
      });
      vi.mocked(rules.getRule).mockResolvedValue(rule);

      const handler = handlers.get('rules:setCategoryA')!;
      const result = await handler({}, 'rule-1', true);
      expect(result).toEqual({ success: false, error: expect.stringContaining('supplier-only rules') });
    });

    it('returns error when cat A rule already exists for supplier', async () => {
      const rule = makeCatARule({ id: 'rule-2', categoryASupplier: false });
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      vi.mocked(rules.getCatARuleForSupplier).mockResolvedValue(
        makeCatARule({ id: 'rule-1' }) // different rule already cat A
      );

      const handler = handlers.get('rules:setCategoryA')!;
      const result = await handler({}, 'rule-2', true);
      expect(result).toEqual({ success: false, error: expect.stringContaining('Cat A rule already exists') });
    });
  });

  // ─── rules:delete cascade ────────────────────────────────────────────────────

  describe('rules:delete (cat A cascade)', () => {
    it('removes path from project supplier and clears flag when last cat A rule deleted', async () => {
      const rule = makeCatARule();
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      const projectSupplier = makeProjectSupplier();
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(projectSupplier as any);
      vi.mocked(rules.getCatARuleForSupplier).mockResolvedValue(null); // no remaining

      const handler = handlers.get('rules:delete')!;
      await handler({}, 'rule-1');

      // Rule deleted
      expect(rules.deleteRule).toHaveBeenCalledWith('rule-1');

      // Path removed from project supplier
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', {
        mappedTaxonomyPaths: [],
      });

      // Flag cleared (last cat A rule removed)
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', { categoryASupplier: false });
    });

    it('does not clear flag when other cat A rules remain', async () => {
      const rule = makeCatARule();
      vi.mocked(rules.getRule).mockResolvedValue(rule);
      const projectSupplier = makeProjectSupplier();
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(projectSupplier as any);
      vi.mocked(rules.getCatARuleForSupplier).mockResolvedValue(
        makeCatARule({ id: 'rule-other' }) // another cat A rule remains
      );

      const handler = handlers.get('rules:delete')!;
      await handler({}, 'rule-1');

      expect(rules.deleteRule).toHaveBeenCalledWith('rule-1');

      // Path still removed
      expect(suppliers.updateSupplier).toHaveBeenCalledWith('sup-1', {
        mappedTaxonomyPaths: [],
      });

      // Flag NOT cleared — another cat A rule exists
      const updateCalls = vi.mocked(suppliers.updateSupplier).mock.calls;
      const flagClearCall = updateCalls.find(
        ([, updates]) => (updates as any).categoryASupplier === false
      );
      expect(flagClearCall).toBeUndefined();
    });

    it('deletes non-cat-A rule without cascade logic', async () => {
      const rule = makeCatARule({ categoryASupplier: false });
      vi.mocked(rules.getRule).mockResolvedValue(rule);

      const handler = handlers.get('rules:delete')!;
      await handler({}, 'rule-1');

      expect(rules.deleteRule).toHaveBeenCalledWith('rule-1');
      expect(suppliers.updateSupplier).not.toHaveBeenCalled();
    });
  });
});
