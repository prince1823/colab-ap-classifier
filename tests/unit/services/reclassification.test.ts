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

vi.mock('../../../src/main/services/changelog', () => ({
  logChange: vi.fn(),
}));

vi.mock('../../../src/main/services/project', () => ({
  getMetadata: vi.fn(),
}));

vi.mock('../../../src/main/services/suppliers', () => ({
  getSupplierByName: vi.fn(),
}));

vi.mock('../../../src/main/agents/feedback-agent', () => ({
  analyzeFeedback: vi.fn(),
}));

import { reclassifyTransactions } from '../../../src/main/services/reclassification';
import { getNodes } from '../../../src/main/services/taxonomy';
import { logChange } from '../../../src/main/services/changelog';
import { analyzeFeedback } from '../../../src/main/agents/feedback-agent';

describe('ReclassificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reclassify a single transaction', async () => {
    vi.mocked(getNodes).mockResolvedValue([
      { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    ]);

    mockAll.mockResolvedValue([
      { id: 'tx1', taxonomy_node_id: 'old-tid' },
    ]);
    mockRun.mockResolvedValue(undefined);
    vi.mocked(logChange).mockResolvedValue('change-id');

    await reclassifyTransactions(['tx1'], 'tid1');

    expect(mockRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET taxonomy_node_id'),
      'tid1',
      'tx1'
    );
    expect(logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['tx1'],
        affectedCount: 1,
      })
    );
  });

  it('should reclassify multiple transactions', async () => {
    vi.mocked(getNodes).mockResolvedValue([
      { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    ]);

    mockAll.mockResolvedValue([
      { id: 'tx1', taxonomy_node_id: 'old-tid' },
      { id: 'tx2', taxonomy_node_id: 'old-tid' },
    ]);
    mockRun.mockResolvedValue(undefined);
    vi.mocked(logChange).mockResolvedValue('change-id');

    await reclassifyTransactions(['tx1', 'tx2'], 'tid1');

    expect(logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        affectedIds: ['tx1', 'tx2'],
        affectedCount: 2,
      })
    );
  });

  it('should throw for invalid taxonomy node', async () => {
    vi.mocked(getNodes).mockResolvedValue([
      { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    ]);

    await expect(
      reclassifyTransactions(['tx1'], 'nonexistent-tid')
    ).rejects.toThrow('Taxonomy node not found: nonexistent-tid');
  });

  it('should throw for empty transaction IDs', async () => {
    await expect(
      reclassifyTransactions([], 'tid1')
    ).rejects.toThrow('No transaction IDs provided');
  });

  it('should trigger feedback agent when feedback is provided', async () => {
    vi.mocked(getNodes).mockResolvedValue([
      { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    ]);

    mockAll.mockResolvedValue([
      { id: 'tx1', taxonomy_node_id: 'old-tid' },
    ]);
    mockRun.mockResolvedValue(undefined);
    vi.mocked(logChange).mockResolvedValue('change-id');
    vi.mocked(analyzeFeedback).mockResolvedValue({
      feedbackType: 'company_context',
      suggestion: { fieldName: 'industry', currentValue: '', proposedValue: 'Tech' },
    });
    mockGet.mockResolvedValue({ supplier_name: 'Acme' });

    await reclassifyTransactions(['tx1'], 'tid1', 'This should be IT');

    // Wait for async feedback
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(analyzeFeedback).toHaveBeenCalled();
  });

  it('should include correct old/new values in changelog', async () => {
    vi.mocked(getNodes).mockResolvedValue([
      { id: 'tid2', fullPath: 'Direct|Materials|Steel', l1: 'Direct', l2: 'Materials', l3: 'Steel', depth: 3, description: null, parentPath: 'Direct|Materials', createdAt: '' },
    ]);

    mockAll.mockResolvedValue([
      { id: 'tx1', taxonomy_node_id: 'old-tid' },
    ]);
    mockRun.mockResolvedValue(undefined);
    vi.mocked(logChange).mockResolvedValue('change-id');

    await reclassifyTransactions(['tx1'], 'tid2');

    expect(logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        oldValues: { taxonomy_node_id: 'old-tid' },
        newValues: { taxonomy_node_id: 'tid2' },
        description: expect.stringContaining('Direct|Materials|Steel'),
      })
    );
  });
});
