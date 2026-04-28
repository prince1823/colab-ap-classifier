import type { QCAgent, LLMClient } from '../../shared/types/services';
import type { QCResult } from '../../shared/types/classification';
import { traceLog } from '../utils/llm-trace';
import { findClosestTaxonomyMatch } from './classification-agent';
import type { TaxonomyNode } from '../../shared/types/taxonomy';

export const DEFAULT_QC_RULES = `- If any tax rows exist for a supplier that is NOT a government entity,
  collapse them into the supplier's primary spend category.
- If transactions fall into categories outside the supplier's known line
  of business, recommend moving them to an aligned category.
- Prefer consolidation to the dominant category when the supplier clearly
  operates in one business area.`;

export function buildQCSystemPrompt(): string {
  return `You are a spend classification QC agent. You review a supplier's current classifications and recommend corrections.

You will receive a full supplier summary including: supplier identity and research, current classifications with spend and transaction detail, company context, and available taxonomy paths.

Apply the QC rules provided to determine what should change. Only recommend changes that are clearly warranted by the rules.

Response format (JSON only):
{
  "recommendations": [
    {
      "groupNumbers": [3, 5],
      "toClassificationPath": "L1|L2|L3",
      "reason": "brief explanation"
    }
  ],
  "noChangeNeeded": false
}

Rules:
- groupNumbers: which transaction groups to move (from the summary)
- toClassificationPath: the target L1|L2|L3 from the available taxonomy
- If no changes needed, return {"recommendations": [], "noChangeNeeded": true}
- Every recommendation must reference valid group numbers and a valid taxonomy path`;
}

export function buildQCUserPrompt(supplierSummary: string, rules: string): string {
  return `${supplierSummary}

## QC Rules
${rules}

Review the above supplier. Apply the QC rules and recommend any reclassifications. Respond with JSON only.`;
}

export function parseQCResponse(responseText: string): QCResult {
  let cleaned = responseText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse QC response: ${cleaned.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  const noChangeNeeded = obj.noChangeNeeded === true;
  const recommendations: QCResult['recommendations'] = [];

  if (Array.isArray(obj.recommendations)) {
    for (const rec of obj.recommendations) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;

      const groupNumbers = Array.isArray(r.groupNumbers)
        ? r.groupNumbers.filter((g): g is number => typeof g === 'number')
        : [];
      const toClassificationPath = typeof r.toClassificationPath === 'string'
        ? r.toClassificationPath
        : '';
      const reason = typeof r.reason === 'string' ? r.reason : '';

      if (groupNumbers.length > 0 && toClassificationPath) {
        recommendations.push({ groupNumbers, toClassificationPath, reason });
      }
    }
  }

  return { recommendations, noChangeNeeded };
}

export class LLMQCAgent implements QCAgent {
  constructor(private llm: LLMClient) {}

  async review(input: { supplierSummary: string; rules: string }, options?: { signal?: AbortSignal }): Promise<QCResult> {
    const systemPrompt = buildQCSystemPrompt();
    const userPrompt = buildQCUserPrompt(input.supplierSummary, input.rules);

    const start = Date.now();
    let responseText: string;
    try {
      responseText = await this.llm.chat(systemPrompt, userPrompt, {
        temperature: 0,
        maxTokens: 4096,
        signal: options?.signal,
      });
    } catch (err) {
      traceLog({
        timestamp: new Date().toISOString(),
        agent: 'qc',
        model: 'default',
        systemPrompt,
        userPrompt,
        response: '',
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const elapsedMs = Date.now() - start;

    let result: QCResult;
    try {
      result = parseQCResponse(responseText);
    } catch (err) {
      traceLog({
        timestamp: new Date().toISOString(),
        agent: 'qc',
        model: 'default',
        systemPrompt,
        userPrompt,
        response: responseText,
        elapsedMs,
        error: `parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    traceLog({
      timestamp: new Date().toISOString(),
      agent: 'qc',
      model: 'default',
      systemPrompt,
      userPrompt,
      response: responseText,
      elapsedMs,
    });

    return result;
  }
}
