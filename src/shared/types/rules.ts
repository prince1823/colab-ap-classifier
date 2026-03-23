import type { GroupedFilter } from './transactions';

export type RuleSource = 'manual' | 'auto_generated';

export interface OverrideRule {
  id: string;
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore: number;
  isActive: boolean;
  source: RuleSource;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore?: number;
  source?: RuleSource;
}

export interface OverrideRuleUpdate {
  name?: string;
  groupedConditions?: GroupedFilter;
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  isActive?: boolean;
}

export interface GenerateRulesResult {
  rulesCreated: number;
  suppliersProcessed: number;
}
