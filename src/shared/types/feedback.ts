export type FeedbackType =
  | 'company_context'
  | 'taxonomy_description'
  | 'supplier_rule'
  | 'uncategorized_feedback';

export type FeedbackStatus = 'pending' | 'approved' | 'rejected';

export interface CompanyContextAction {
  fieldName: 'industry' | 'sector' | 'businessFocus' | 'description' | 'procurementNuances';
  currentValue: string;
  proposedValue: string;
}

export interface TaxonomyDescriptionAction {
  taxonomyPath: string;
  currentDescription: string;
  proposedDescription: string;
}

export interface SupplierRuleAction {
  supplierName: string;
  ruleCategory: 'A';
  classificationPaths: string[];
}

export interface UncategorizedFeedbackAction {
  issueType:
    | 'pattern_recognition'
    | 'taxonomy_gap'
    | 'prompt_failure'
    | 'data_enrichment_needed'
    | 'supplier_complexity'
    | 'edge_case'
    | 'other';
  description: string;
  affectedPattern: string;
  suggestedFix: string;
  exampleTransactions: string;
}

export type FeedbackActionDetails =
  | CompanyContextAction
  | TaxonomyDescriptionAction
  | SupplierRuleAction
  | UncategorizedFeedbackAction;

export interface SystemFeedback {
  id: string;
  feedbackType: FeedbackType;
  affectedTransactionIds: string[] | null;
  suggestion: FeedbackActionDetails;
  status: FeedbackStatus;
  createdAt: string;
}
