import { describe, it, expect, vi } from 'vitest';
import { buildUserPrompt, parseResponse, LLMCatAAgent } from '../../../src/main/agents/cat-a-agent';
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

const nodes: TaxonomyNode[] = [
  makeNode('Corporate Services|IT|Software'),
  makeNode('Corporate Services|IT|Hardware'),
  makeNode('Professional Services|Consulting|Strategy'),
];

describe('buildUserPrompt', () => {
  it('includes the mapped path and all taxonomy paths', () => {
    const prompt = buildUserPrompt('IT|Software Tools', nodes);
    expect(prompt).toContain('IT|Software Tools');
    expect(prompt).toContain('Corporate Services|IT|Software');
    expect(prompt).toContain('Professional Services|Consulting|Strategy');
  });
});

describe('parseResponse', () => {
  it('parses a well-formed JSON response', () => {
    const result = parseResponse(JSON.stringify({ resolvedPath: 'Corporate Services|IT|Software' }));
    expect(result.resolvedPath).toBe('Corporate Services|IT|Software');
  });

  it('strips markdown code fences', () => {
    const result = parseResponse('```json\n{"resolvedPath":"Corporate Services|IT|Hardware"}\n```');
    expect(result.resolvedPath).toBe('Corporate Services|IT|Hardware');
  });

  it('throws on malformed response', () => {
    expect(() => parseResponse('not json at all')).toThrow();
  });

  it('throws if resolvedPath is missing', () => {
    expect(() => parseResponse(JSON.stringify({ other: 'field' }))).toThrow();
  });
});

describe('LLMCatAAgent', () => {
  it('returns exact match without calling LLM', async () => {
    const mockLlm = { chat: vi.fn() };
    const agent = new LLMCatAAgent(mockLlm);
    const result = await agent.resolve('Corporate Services|IT|Software', nodes);
    expect(result.resolvedPath).toBe('Corporate Services|IT|Software');
    expect(mockLlm.chat).not.toHaveBeenCalled();
  });

  it('calls LLM when no exact match and returns resolved path', async () => {
    const mockLlm = {
      chat: vi.fn().mockResolvedValue(JSON.stringify({ resolvedPath: 'Corporate Services|IT|Software' })),
    };
    const agent = new LLMCatAAgent(mockLlm);
    const result = await agent.resolve('IT Software Tools', nodes);
    expect(mockLlm.chat).toHaveBeenCalledOnce();
    expect(result.resolvedPath).toBe('Corporate Services|IT|Software');
  });
});
