import type { FeedbackAgent, LLMClient } from '../../shared/types/services';
import type { FeedbackAgentInput, FeedbackRecommendation, FeedbackActionType, FeedbackDetails } from '../../shared/types/feedback';
import type { ChangeLog } from '../../shared/types/changelog';

const VALID_ACTIONS: FeedbackActionType[] = [
  'update_taxonomy_description',
  'update_supplier_info',
  'update_company_context',
  'update_column_priority',
  'create_rule',
  'no_change',
];

/**
 * Build the system prompt for the feedback agent.
 */
export function buildSystemPrompt(): string {
  return `You are a classification system improvement advisor. When a user manually reclassifies AP transactions, you analyze what went wrong and recommend ONE system-level change to prevent the same misclassification in the future.

## Available Actions

You must recommend exactly ONE of these actions:

1. **update_taxonomy_description** — One or both taxonomy nodes (the incorrectly-classified-to node and/or the correctly-classified-to node) have missing or misleading descriptions. You may update 1–2 nodes: add exclusion language to the wrong node, inclusion language to the right node, or both.

2. **update_supplier_info** — The supplier's profile information is missing or incorrect, causing the classifier to misinterpret what the supplier provides. Suggest updating a specific field.

3. **update_company_context** — The company context is missing nuance about the business that would help the classifier make better decisions. Suggest updating a specific field.

4. **update_column_priority** — The column priority ordering is suboptimal, causing the classifier to weight less informative fields over more informative ones. Suggest a reordering.

5. **create_rule** — A deterministic rule would be more reliable than LLM classification for this pattern. Suggest a rule with conditions and target taxonomy path.

6. **no_change** — The misclassification was a one-off edge case or the system already has the right information. No system change would reliably prevent it.

## Decision Guidelines

- Prefer **taxonomy_description** when the old and new classifications are in similar categories and the distinction is unclear without a description. Target the "before" node to add exclusion language, the "after" node to add inclusion language, or both if both descriptions are weak.
- Prefer **supplier_info** when the supplier's type, industry, or offerings would have made the correct classification obvious
- Prefer **company_context** when domain-specific knowledge about the company's business would change interpretation
- Prefer **column_priority** when the wrong field was weighted too heavily (rare — only suggest if clearly suboptimal)
- Prefer **create_rule** when the pattern is deterministic (e.g., specific supplier always maps to specific category)
- Prefer **no_change** when the misclassification seems like a genuine edge case

## Response Format

Respond with valid JSON only. No markdown fencing, no text outside the JSON.

{
  "action": "<one of the 6 action types>",
  "reasoning": "<1-2 sentences explaining why this action would prevent the misclassification>",
  "details": { <action-specific fields — see below> }
}

### Details by action type:

**update_taxonomy_description:**
{ "type": "update_taxonomy_description", "updates": [ { "nodeId": "<UUID>", "nodePath": "<L1|L2|L3 path>", "currentDescription": "<current or null>", "proposedDescription": "<suggested>" }, ... ] }
Include 1 or 2 entries. Only include a node if its current description is ABSENT or would ACTIVELY MISLEAD the classifier into making the same wrong choice again. Do NOT include a node just to rephrase or polish an already-adequate description — omit it entirely in that case.

**update_supplier_info:**
{ "type": "update_supplier_info", "supplierName": "<name>", "field": "<SupplierInfo field name>", "currentValue": "<current value or null>", "proposedValue": "<suggested value>" }

**update_company_context:**
{ "type": "update_company_context", "field": "<CompanyContext field name>", "currentValue": "<current value or null>", "proposedValue": "<suggested value>" }

**update_column_priority:**
{ "type": "update_column_priority", "currentPriorities": ["<current order>"], "proposedPriorities": ["<suggested order>"] }

**create_rule:**
{ "type": "create_rule", "name": "<descriptive rule name>", "conditions": [{ "field": "<column>", "operator": "<equals|contains|regex>", "value": "<match value>" }], "targetTaxonomyPath": "<L1|L2|L3>" }

**no_change:**
{ "type": "no_change", "explanation": "<why no system change would help>" }`;
}

/**
 * Format changelog entries into a readable diff for the prompt.
 */
function formatChangelogs(changelogs: ChangeLog[], taxonomyMap: Map<string, string>): string {
  if (changelogs.length === 0) return '(No changes provided)';

  return changelogs.map((entry, i) => {
    const parts: string[] = [`Change ${i + 1}:`];
    parts.push(`  Source: ${entry.source}`);
    parts.push(`  Table: ${entry.affectedTable}`);
    parts.push(`  Affected rows: ${entry.affectedCount}`);
    if (entry.description) parts.push(`  Description: ${entry.description}`);

    if (entry.oldValues) {
      const resolved = resolveValues(entry.oldValues, taxonomyMap);
      parts.push(`  Before: ${JSON.stringify(resolved)}`);
    }
    if (entry.newValues) {
      const resolved = resolveValues(entry.newValues, taxonomyMap);
      parts.push(`  After: ${JSON.stringify(resolved)}`);
    }

    return parts.join('\n');
  }).join('\n\n');
}

/**
 * Resolve taxonomy_node_id UUIDs to human-readable paths.
 */
function resolveValues(
  values: Record<string, unknown>,
  taxonomyMap: Map<string, string>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(values)) {
    if (key === 'taxonomy_node_id' && typeof val === 'string' && taxonomyMap.has(val)) {
      resolved['classification'] = taxonomyMap.get(val);
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

/**
 * Build the user prompt with all feedback context.
 */
export function buildUserPrompt(input: FeedbackAgentInput): string {
  const { changelogs, userFeedback, taxonomy, companyContext, columnPriorities } = input;

  // Build taxonomy map for UUID resolution
  const taxonomyMap = new Map(taxonomy.map(n => [n.id, n.fullPath]));

  // Format taxonomy with descriptions (only L3 nodes)
  const taxonomyLines = taxonomy
    .filter(n => n.depth === 3)
    .map(n => {
      const desc = n.description ? ` — ${n.description}` : '';
      return `  ${n.fullPath} [id: ${n.id}]${desc}`;
    });

  // Format company context
  const contextParts: string[] = [];
  if (companyContext) {
    if (companyContext.companyName) contextParts.push(`Company: ${companyContext.companyName}`);
    if (companyContext.industry) contextParts.push(`Industry: ${companyContext.industry}`);
    if (companyContext.description) contextParts.push(`Description: ${companyContext.description}`);
    if (companyContext.sisterCompanies) contextParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
    if (companyContext.additionalDetails) contextParts.push(`Additional Details: ${companyContext.additionalDetails}`);
  }

  return `## User Feedback
${userFeedback}

## Changes Made by User
${formatChangelogs(changelogs, taxonomyMap)}

## Current Taxonomy (L3 nodes with descriptions)
${taxonomyLines.length > 0 ? taxonomyLines.join('\n') : '(No taxonomy nodes)'}

## Company Context
${contextParts.length > 0 ? contextParts.join('\n') : '(No company context set)'}

## Column Priorities
${columnPriorities.length > 0 ? columnPriorities.join(', ') : '(No column priorities set)'}

Based on the user's feedback and the changes they made, recommend ONE system-level change that would prevent this misclassification in the future. Respond with JSON only.`;
}

/**
 * Parse the LLM response text into a FeedbackRecommendation.
 */
export function parseResponse(responseText: string): FeedbackRecommendation {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Parse JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      action: 'no_change',
      reasoning: 'Could not parse agent response.',
      details: { type: 'no_change', explanation: `Parse error: ${cleaned.slice(0, 200)}` },
    };
  }

  // Validate action
  const action = parsed.action as string;
  if (!VALID_ACTIONS.includes(action as FeedbackActionType)) {
    return {
      action: 'no_change',
      reasoning: String(parsed.reasoning || 'Unknown action type returned.'),
      details: { type: 'no_change', explanation: `Unknown action: ${action}` },
    };
  }

  const reasoning = String(parsed.reasoning || '');
  const details = parsed.details as Record<string, unknown> | undefined;

  if (!details || typeof details !== 'object') {
    return {
      action: 'no_change',
      reasoning,
      details: { type: 'no_change', explanation: 'No details provided in response.' },
    };
  }

  // Validate details.type matches action
  if (details.type !== action) {
    details.type = action;
  }

  // Normalize update_taxonomy_description: coerce old single-node format into updates array
  if (action === 'update_taxonomy_description') {
    if (!Array.isArray(details.updates)) {
      // LLM returned old format: { nodeId, nodePath, currentDescription, proposedDescription }
      details.updates = [{
        nodeId: String(details.nodeId ?? ''),
        nodePath: String(details.nodePath ?? ''),
        currentDescription: details.currentDescription != null ? String(details.currentDescription) : null,
        proposedDescription: String(details.proposedDescription ?? ''),
      }];
    }
    // Drop any entries where the proposed description is identical to the current one
    details.updates = (details.updates as Array<{ nodeId: string; nodePath: string; currentDescription: string | null; proposedDescription: string }>)
      .filter(u => u.proposedDescription.trim() !== (u.currentDescription ?? '').trim());
    // If all updates were no-ops, fall back to no_change
    if ((details.updates as unknown[]).length === 0) {
      return {
        action: 'no_change',
        reasoning: reasoning || 'All proposed taxonomy descriptions were identical to the current ones.',
        details: { type: 'no_change', explanation: 'No meaningful description changes were proposed.' },
      };
    }
  }

  return {
    action: action as FeedbackActionType,
    reasoning,
    details: details as FeedbackDetails,
  };
}

/**
 * DI-compatible feedback agent class.
 */
export class LLMFeedbackAgent implements FeedbackAgent {
  constructor(private llm: LLMClient) {}

  async analyze(input: FeedbackAgentInput): Promise<FeedbackRecommendation> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input);

    const responseText = await this.llm.chat(systemPrompt, userPrompt, {
      temperature: 0,
      maxTokens: 4096,
    });

    return parseResponse(responseText);
  }
}
