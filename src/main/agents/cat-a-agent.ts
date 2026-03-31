import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { CatAAgent, LLMClient } from '../../shared/types/services';
import { traceLog } from '../utils/llm-trace';

export function buildSystemPrompt(): string {
  return `You are a taxonomy path resolver. Given a proposed taxonomy path and a list of valid taxonomy paths from a project, find the closest matching path.

Taxonomy paths use pipe-delimited format: "L1|L2|L3".

Return a JSON object with this exact structure:
{ "resolvedPath": "L1|L2|L3" }

Rules:
- You MUST return a path that exists exactly in the provided list
- Choose the path that is semantically closest to the proposed path
- Consider synonyms, abbreviations, and related concepts
- Do not invent or modify paths`;
}

export function buildUserPrompt(mappedPath: string, taxonomyNodes: TaxonomyNode[]): string {
  const paths = taxonomyNodes.map((n) => n.fullPath).join('\n');
  return `Proposed path: "${mappedPath}"

Available taxonomy paths:
${paths}

Return the closest matching path as JSON.`;
}

export interface CatAResolution {
  resolvedPath: string;
}

export function parseResponse(text: string): CatAResolution {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.resolvedPath === 'string' && parsed.resolvedPath.length > 0) {
      return { resolvedPath: parsed.resolvedPath };
    }
  } catch { /* fall through */ }
  throw new Error(`CatAAgent: could not parse response: ${text.slice(0, 200)}`);
}

export class LLMCatAAgent implements CatAAgent {
  constructor(private llm: LLMClient) {}

  async resolve(mappedPath: string, taxonomyNodes: TaxonomyNode[]): Promise<CatAResolution> {
    // Exact match — no LLM call needed
    const exact = taxonomyNodes.find((n) => n.fullPath === mappedPath);
    if (exact) return { resolvedPath: exact.fullPath };

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(mappedPath, taxonomyNodes);
    const response = await this.llm.chat(systemPrompt, userPrompt, { temperature: 0, maxTokens: 256 });
    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'cat-a',
      model: 'default',
      systemPrompt,
      userPrompt,
      response,
      elapsedMs: 0,
    });
    return parseResponse(response);
  }
}
