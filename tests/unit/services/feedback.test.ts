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

vi.mock('../../../src/main/services/changelog', () => ({
  logChange: vi.fn().mockResolvedValue('change-id'),
}));

vi.mock('../../../src/main/services/rules', () => ({
  createRule: vi.fn().mockResolvedValue({ id: 'rule-id' }),
}));

import {
  listFeedback,
  createFeedback,
  approveFeedback,
  rejectFeedback,
} from '../../../src/main/services/feedback';
import { logChange } from '../../../src/main/services/changelog';
import { createRule } from '../../../src/main/services/rules';

describe('FeedbackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listFeedback', () => {
    it('should return feedback entries sorted by created_at desc', async () => {
      mockAll.mockResolvedValue([
        {
          id: 'fb1',
          feedback_type: 'company_context',
          affected_transaction_ids: '["tx1"]',
          suggestion: '{"fieldName":"industry","currentValue":"","proposedValue":"Tech"}',
          status: 'pending',
          created_at: '2026-01-02',
        },
        {
          id: 'fb2',
          feedback_type: 'taxonomy_description',
          affected_transaction_ids: null,
          suggestion: '{"taxonomyPath":"Indirect|IT","currentDescription":"","proposedDescription":"IT services"}',
          status: 'approved',
          created_at: '2026-01-01',
        },
      ]);

      const feedback = await listFeedback();
      expect(feedback).toHaveLength(2);
      expect(feedback[0].id).toBe('fb1');
      expect(feedback[0].feedbackType).toBe('company_context');
      expect(feedback[0].affectedTransactionIds).toEqual(['tx1']);
      expect(feedback[1].affectedTransactionIds).toBeNull();
    });
  });

  describe('createFeedback', () => {
    it('should insert a feedback entry', async () => {
      mockRun.mockResolvedValue(undefined);

      const id = await createFeedback({
        feedbackType: 'company_context',
        affectedTransactionIds: ['tx1'],
        suggestion: { fieldName: 'industry', currentValue: '', proposedValue: 'Tech' },
        status: 'pending',
      });

      expect(id).toBeDefined();
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO system_feedback'),
        expect.any(String),
        'company_context',
        '["tx1"]',
        expect.stringContaining('industry'),
        'pending'
      );
    });
  });

  describe('approveFeedback', () => {
    it('should approve and apply company_context feedback', async () => {
      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('system_feedback')) {
          return {
            id: 'fb1',
            feedback_type: 'company_context',
            affected_transaction_ids: '["tx1"]',
            suggestion: '{"fieldName":"industry","currentValue":"","proposedValue":"Manufacturing"}',
            status: 'pending',
            created_at: '2026-01-01',
          };
        }
        if (sql.includes('company_context')) {
          return { id: 'cc1' };
        }
        return undefined;
      });
      mockRun.mockResolvedValue(undefined);

      await approveFeedback('fb1');

      // Should have updated company_context
      const updateCall = mockRun.mock.calls.find((c) =>
        String(c[0]).includes('UPDATE company_context')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe('Manufacturing');

      // Should have logged to changelog
      expect(logChange).toHaveBeenCalled();

      // Should have updated feedback status
      const statusCall = mockRun.mock.calls.find((c) =>
        String(c[0]).includes("UPDATE system_feedback SET status = 'approved'")
      );
      expect(statusCall).toBeDefined();
    });

    it('should approve and apply taxonomy_description feedback', async () => {
      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('system_feedback')) {
          return {
            id: 'fb2',
            feedback_type: 'taxonomy_description',
            affected_transaction_ids: null,
            suggestion: '{"taxonomyPath":"Indirect|IT|Software","currentDescription":"","proposedDescription":"Software licenses"}',
            status: 'pending',
            created_at: '2026-01-01',
          };
        }
        return undefined;
      });
      mockRun.mockResolvedValue(undefined);

      await approveFeedback('fb2');

      const updateCall = mockRun.mock.calls.find((c) =>
        String(c[0]).includes('UPDATE taxonomy SET description')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe('Software licenses');
      expect(updateCall![2]).toBe('Indirect|IT|Software');
    });

    it('should approve and apply supplier_rule feedback', async () => {
      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('system_feedback')) {
          return {
            id: 'fb3',
            feedback_type: 'supplier_rule',
            affected_transaction_ids: '["tx1"]',
            suggestion: '{"supplierName":"Acme","ruleCategory":"A","classificationPaths":["Indirect|IT|Software"]}',
            status: 'pending',
            created_at: '2026-01-01',
          };
        }
        if (sql.includes('taxonomy WHERE full_path')) {
          return { id: 'tid1' };
        }
        return undefined;
      });
      mockRun.mockResolvedValue(undefined);

      await approveFeedback('fb3');

      expect(createRule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Feedback Rule: Acme',
          source: 'project',
          targetTaxonomyNodeId: 'tid1',
        })
      );
    });

    it('should throw if feedback not found', async () => {
      mockGet.mockResolvedValue(undefined);

      await expect(approveFeedback('nonexistent')).rejects.toThrow(
        'Feedback entry not found: nonexistent'
      );
    });

    it('should throw if already approved', async () => {
      mockGet.mockResolvedValue({
        id: 'fb1',
        feedback_type: 'company_context',
        affected_transaction_ids: null,
        suggestion: '{}',
        status: 'approved',
        created_at: '',
      });

      await expect(approveFeedback('fb1')).rejects.toThrow(
        'Feedback fb1 is already approved'
      );
    });

    it('should apply modifications before executing', async () => {
      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('system_feedback')) {
          return {
            id: 'fb1',
            feedback_type: 'company_context',
            affected_transaction_ids: null,
            suggestion: '{"fieldName":"industry","currentValue":"","proposedValue":"Tech"}',
            status: 'pending',
            created_at: '',
          };
        }
        if (sql.includes('company_context')) {
          return { id: 'cc1' };
        }
        return undefined;
      });
      mockRun.mockResolvedValue(undefined);

      await approveFeedback('fb1', { proposedValue: 'Modified Tech' } as any);

      const updateCall = mockRun.mock.calls.find((c) =>
        String(c[0]).includes('UPDATE company_context')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe('Modified Tech');
    });
  });

  describe('rejectFeedback', () => {
    it('should reject a pending feedback', async () => {
      mockGet.mockResolvedValue({
        id: 'fb1',
        feedback_type: 'company_context',
        affected_transaction_ids: null,
        suggestion: '{}',
        status: 'pending',
        created_at: '',
      });
      mockRun.mockResolvedValue(undefined);

      await rejectFeedback('fb1', 'Not applicable');

      expect(mockRun).toHaveBeenCalledWith(
        "UPDATE system_feedback SET status = 'rejected' WHERE id = ?",
        'fb1'
      );
    });

    it('should throw if feedback not found', async () => {
      mockGet.mockResolvedValue(undefined);

      await expect(rejectFeedback('nonexistent')).rejects.toThrow(
        'Feedback entry not found: nonexistent'
      );
    });

    it('should throw if already rejected', async () => {
      mockGet.mockResolvedValue({
        id: 'fb1',
        feedback_type: 'company_context',
        affected_transaction_ids: null,
        suggestion: '{}',
        status: 'rejected',
        created_at: '',
      });

      await expect(rejectFeedback('fb1')).rejects.toThrow(
        'Feedback fb1 is already rejected'
      );
    });
  });
});
