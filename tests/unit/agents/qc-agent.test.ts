import { describe, it, expect, vi } from 'vitest';
import {
  buildQCSystemPrompt,
  buildQCUserPrompt,
  parseQCResponse,
  DEFAULT_QC_RULES,
  LLMQCAgent,
} from '../../../src/main/agents/qc-agent';
import type { LLMClient } from '../../../src/shared/types/services';

describe('QC Agent', () => {
  describe('buildQCSystemPrompt', () => {
    it('should include QC-specific instructions', () => {
      const prompt = buildQCSystemPrompt();
      expect(prompt).toContain('QC agent');
      expect(prompt).toContain('recommendations');
      expect(prompt).toContain('groupNumbers');
      expect(prompt).toContain('noChangeNeeded');
    });
  });

  describe('buildQCUserPrompt', () => {
    it('should include supplier summary and rules', () => {
      const prompt = buildQCUserPrompt('SUPPLIER CONTEXT\n  Name: Acme', 'Custom rule');
      expect(prompt).toContain('SUPPLIER CONTEXT');
      expect(prompt).toContain('Acme');
      expect(prompt).toContain('## QC Rules');
      expect(prompt).toContain('Custom rule');
    });
  });

  describe('parseQCResponse', () => {
    it('should parse valid recommendations', () => {
      const text = JSON.stringify({
        recommendations: [
          { groupNumbers: [3, 5], toClassificationPath: 'IT|Consulting|IT Consulting', reason: 'test' },
        ],
        noChangeNeeded: false,
      });
      const result = parseQCResponse(text);
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].groupNumbers).toEqual([3, 5]);
      expect(result.noChangeNeeded).toBe(false);
    });

    it('should parse noChangeNeeded response', () => {
      const text = JSON.stringify({ recommendations: [], noChangeNeeded: true });
      const result = parseQCResponse(text);
      expect(result.recommendations).toHaveLength(0);
      expect(result.noChangeNeeded).toBe(true);
    });

    it('should skip invalid recommendations (missing fields)', () => {
      const text = JSON.stringify({
        recommendations: [
          { groupNumbers: [1], toClassificationPath: 'Valid|Path|Here', reason: 'ok' },
          { groupNumbers: [], toClassificationPath: 'No|Groups|Here', reason: 'invalid' },
          { groupNumbers: [2] },  // missing path
        ],
        noChangeNeeded: false,
      });
      const result = parseQCResponse(text);
      expect(result.recommendations).toHaveLength(1);
    });

    it('should handle markdown fences', () => {
      const text = '```json\n{"recommendations": [], "noChangeNeeded": true}\n```';
      const result = parseQCResponse(text);
      expect(result.noChangeNeeded).toBe(true);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseQCResponse('not json')).toThrow('Failed to parse');
    });
  });

  describe('DEFAULT_QC_RULES', () => {
    it('should be a non-empty string', () => {
      expect(DEFAULT_QC_RULES).toBeTruthy();
      expect(DEFAULT_QC_RULES).toContain('tax');
      expect(DEFAULT_QC_RULES).toContain('consolidation');
    });
  });

  describe('LLMQCAgent', () => {
    it('should call LLM and return parsed result', async () => {
      const mockLLM: LLMClient = {
        chat: vi.fn().mockResolvedValue(JSON.stringify({
          recommendations: [
            { groupNumbers: [1], toClassificationPath: 'IT|Software|SaaS', reason: 'test' },
          ],
          noChangeNeeded: false,
        })),
      };

      const agent = new LLMQCAgent(mockLLM);
      const result = await agent.review({
        supplierSummary: 'Test summary',
        rules: 'Test rules',
      });

      expect(mockLLM.chat).toHaveBeenCalledOnce();
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].toClassificationPath).toBe('IT|Software|SaaS');
    });
  });
});
