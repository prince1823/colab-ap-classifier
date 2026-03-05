import type { FilterCondition } from './transactions';

export type OverrideRuleSource = 'project' | 'taxonomy' | 'global';

export interface OverrideRule {
  id: string;
  name: string;
  source: OverrideRuleSource;
  conditions: FilterCondition[];
  targetTaxonomyNodeId: string;
  priorityScore: number;
  isActive: boolean;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  source?: OverrideRuleSource;
  conditions: FilterCondition[];
  targetTaxonomyNodeId: string;
  priorityScore?: number;
}

export interface OverrideRuleUpdate {
  name?: string;
  conditions?: FilterCondition[];
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  isActive?: boolean;
}
