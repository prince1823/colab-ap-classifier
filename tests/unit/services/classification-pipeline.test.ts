import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRun = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();

vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: (...args: unknown[]) => mockRun(...args),
    all: (...args: unknown[]) => mockAll(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

vi.mock('../../../src/main/services/taxonomy', () => ({
  getNodes: vi.fn(),
}));

vi.mock('../../../src/main/services/project', () => ({
  getMetadata: vi.fn(),
}));

vi.mock('../../../src/main/services/supplier-research', () => ({
  researchBatch: vi.fn(),
}));

vi.mock('../../../src/main/services/rules', () => ({
  syncRulesFromSources: vi.fn(),
  evaluateRules: vi.fn(),
}));

vi.mock('../../../src/main/services/suppliers', () => ({
  getSupplierByName: vi.fn(),
}));

vi.mock('../../../src/main/agents/classification-agent', () => ({
  classifyInvoiceGroup: vi.fn(),
}));

vi.mock('../../../src/main/services/changelog', () => ({
  logChange: vi.fn(),
}));

import {
  startClassification,
  getStatus,
  cancelClassification,
  cleanDescription,
} from '../../../src/main/services/classification-pipeline';
import { evaluateRules, syncRulesFromSources } from '../../../src/main/services/rules';
import { researchBatch } from '../../../src/main/services/supplier-research';
import { classifyInvoiceGroup } from '../../../src/main/agents/classification-agent';
import { getNodes } from '../../../src/main/services/taxonomy';
import { getMetadata } from '../../../src/main/services/project';

describe('ClassificationPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cleanDescription', () => {
    it('should strip numeric characters when >= 70% numeric', () => {
      const result = cleanDescription('1234567abc');
      // 7 numeric out of 10 non-whitespace = 70%
      expect(result).not.toContain('1');
      expect(result).toContain('abc');
    });

    it('should keep description when < 70% numeric', () => {
      const result = cleanDescription('hello world 123');
      expect(result).toBe('hello world 123');
    });

    it('should handle empty string', () => {
      expect(cleanDescription('')).toBe('');
    });
  });

  describe('startClassification', () => {
    it('should return a runId', async () => {
      // No transactions found
      mockAll.mockResolvedValue([]);

      const result = await startClassification({ scope: 'all' });
      expect(result.runId).toBeDefined();
    });

    it('should reject if already running', async () => {
      // First call: long-running pipeline
      mockAll.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ id: 'tx1' }]), 5000))
      );

      const result1 = await startClassification({ scope: 'all' });
      expect(result1.runId).toBeDefined();

      // Second call should throw
      await expect(startClassification({ scope: 'all' })).rejects.toThrow(
        'A classification job is already running'
      );

      // Cancel the running job
      await cancelClassification(result1.runId);
    });
  });

  describe('getStatus', () => {
    it('should return current run status', async () => {
      mockAll.mockResolvedValue([]);
      await startClassification({ scope: 'all' });

      const status = getStatus();
      expect(status).not.toBeNull();
      expect(status?.scope).toBe('all');
    });
  });

  describe('cancelClassification', () => {
    it('should mark run as cancelled', async () => {
      mockAll.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ id: 'tx1' }]), 5000))
      );

      const { runId } = await startClassification({ scope: 'all' });
      await cancelClassification(runId);

      const status = getStatus();
      expect(status?.status).toBe('cancelled');
    });
  });

  describe('pipeline execution', () => {
    it('should complete with no transactions', async () => {
      mockAll.mockResolvedValue([]);

      const { runId } = await startClassification({ scope: 'all' });

      // Wait for async pipeline
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = getStatus();
      expect(status?.status).toBe('completed');
    });

    it('should apply override rules before LLM classification', async () => {
      // Step 1: identify rows
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM transactions')) {
          return [{ id: 'tx1' }, { id: 'tx2' }];
        }
        if (sql.includes('DISTINCT supplier_name')) {
          return [{ supplier_name: 'Acme' }];
        }
        if (sql.includes('invoice_grouping_columns')) {
          return [];
        }
        if (sql.includes('SELECT * FROM transactions WHERE id')) {
          return [
            { id: 'tx2', supplier_name: 'TestCorp', row_index: 1, spend_amount: 5000, created_at: '', updated_at: '' },
          ];
        }
        if (sql.includes('information_schema.columns')) {
          return [
            { column_name: 'id' }, { column_name: 'row_index' },
            { column_name: 'supplier_name' }, { column_name: 'spend_amount' },
          ];
        }
        return [];
      });

      vi.mocked(researchBatch).mockResolvedValue(undefined);
      vi.mocked(syncRulesFromSources).mockResolvedValue(undefined);

      // Override rules match tx1
      const ruleMap = new Map([['tx1', 'rule1']]);
      vi.mocked(evaluateRules).mockResolvedValue(ruleMap);

      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('override_rules')) {
          return { target_taxonomy_node_id: 'tid1' };
        }
        return undefined;
      });
      mockRun.mockResolvedValue(undefined);

      vi.mocked(getNodes).mockResolvedValue([
        { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
      ]);

      vi.mocked(getMetadata).mockResolvedValue({
        name: 'Test',
        filePath: '/test.c91',
        companyContext: { industry: 'Tech' },
        columnMappings: null,
        invoiceGroupingColumns: null,
        tailSpendThreshold: 10000,
        taxonomyName: null,
        createdAt: null,
      });

      vi.mocked(classifyInvoiceGroup).mockResolvedValue({
        classificationPath: 'Indirect|IT|Software',
        reasoning: 'Test reasoning',
        descriptionSupplierAligned: true,
      });

      const { runId } = await startClassification({ scope: 'all' });

      // Wait for pipeline
      await new Promise((resolve) => setTimeout(resolve, 500));

      // syncRulesFromSources should have been called
      expect(syncRulesFromSources).toHaveBeenCalled();
      // evaluateRules should have been called
      expect(evaluateRules).toHaveBeenCalled();
    });
  });
});
