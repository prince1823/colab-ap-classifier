export type RuleSource = 'project' | 'taxonomy' | 'supplier';

export type RuleOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'regex'
  | 'in_list'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal';

export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value: string | number | string[];
  /** How this condition joins to the next condition. Default: 'AND'. Ignored on the last condition. */
  connector?: 'AND' | 'OR';
}

export interface OverrideRule {
  id: string;
  name: string;
  source: RuleSource;
  conditions: RuleCondition[];
  targetTaxonomyNodeId: string;
  priorityScore: number;
  isActive: boolean;
  importedAt: string | null;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  source: RuleSource;
  conditions: RuleCondition[];
  targetTaxonomyNodeId: string;
  priorityScore?: number;
}

export interface OverrideRuleUpdate {
  name?: string;
  conditions?: RuleCondition[];
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  isActive?: boolean;
}
