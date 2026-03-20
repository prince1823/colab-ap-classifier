import type { GroupedFilter } from './transactions';

export type OverrideRuleSource = 'project' | 'taxonomy' | 'global';

export interface OverrideRule {
  id: string;
  name: string;
  source: OverrideRuleSource;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore: number;
  isActive: boolean;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  source?: OverrideRuleSource;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore?: number;
}

export interface OverrideRuleUpdate {
  name?: string;
  groupedConditions?: GroupedFilter;
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  isActive?: boolean;
}
