import type { FilterCondition } from './transactions';
import type { ChangeLog } from './changelog';
import type { TaxonomyNode } from './taxonomy';
import type { CompanyContext } from './project';

// ─── Action Types ────────────────────────────────────────────────────────────

export type FeedbackActionType =
  | 'update_taxonomy_description'
  | 'update_supplier_info'
  | 'update_company_context'
  | 'update_column_priority'
  | 'create_rule'
  | 'no_change';

// ─── Discriminated Details Union ─────────────────────────────────────────────

export type FeedbackDetails =
  | { type: 'update_taxonomy_description'; nodeId: string; nodePath: string; currentDescription: string | null; proposedDescription: string }
  | { type: 'update_supplier_info'; supplierName: string; field: string; currentValue: string | null; proposedValue: string }
  | { type: 'update_company_context'; field: string; currentValue: string | null; proposedValue: string }
  | { type: 'update_column_priority'; currentPriorities: string[]; proposedPriorities: string[] }
  | { type: 'create_rule'; name: string; conditions: FilterCondition[]; targetTaxonomyPath: string }
  | { type: 'no_change'; explanation: string };

// ─── IPC Types ───────────────────────────────────────────────────────────────

export interface FeedbackAnalyzeInput {
  changelogIds: string[];
  userFeedback: string;
}

export interface FeedbackRecommendation {
  action: FeedbackActionType;
  reasoning: string;
  details: FeedbackDetails;
}

export interface FeedbackApplyInput {
  recommendation: FeedbackRecommendation;
}

// ─── Agent Input (resolved from IPC input by handler) ────────────────────────

export interface FeedbackAgentInput {
  changelogs: ChangeLog[];
  userFeedback: string;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext | null;
  columnPriorities: string[];
}
