// Core IPC response envelope
export interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// All 52 IPC channel names (canonicalization:suggest removed — folded into upload:parsePreview)
export type IPCChannel =
  // Project (8 channels)
  | 'project:isOpen'
  | 'project:selectSavePath'
  | 'project:selectOpenPath'
  | 'project:new'
  | 'project:open'
  | 'project:close'
  | 'project:getMetadata'
  | 'project:updateMetadata'
  // Recent Projects (3 channels)
  | 'recentProjects:list'
  | 'recentProjects:clear'
  | 'recentProjects:remove'
  // Upload (3 channels)
  | 'upload:selectFile'
  | 'upload:parsePreview'
  | 'upload:csv'
  // Canonicalization (1 channel — suggest was folded into upload:parsePreview)
  | 'canonicalization:save'
  // Classification (3 channels + 1 event)
  | 'classification:start'
  | 'classification:getStatus'
  | 'classification:cancel'
  | 'classification:progress'
  // Transactions (4 channels)
  | 'transactions:query'
  | 'transactions:stats'
  | 'transactions:getColumns'
  | 'transactions:reclassify'
  // Taxonomy (4 channels)
  | 'taxonomy:get'
  | 'taxonomy:getNodes'
  | 'taxonomy:set'
  | 'taxonomy:importFromColabip'
  // ColabIP (2 channels)
  | 'colabip:listTaxonomies'
  | 'colabip:listRulePacks'
  // Suppliers (3 channels)
  | 'suppliers:list'
  | 'suppliers:update'
  | 'suppliers:research'
  // Rules (5 channels)
  | 'rules:list'
  | 'rules:create'
  | 'rules:update'
  | 'rules:delete'
  | 'rules:importFromColabip'
  // Feedback (3 channels)
  | 'feedback:list'
  | 'feedback:approve'
  | 'feedback:reject'
  // Changelog (2 channels)
  | 'changelog:list'
  | 'changelog:revert'
  // Export (2 channels)
  | 'export:selectPath'
  | 'export:export'
  // Settings (4 channels)
  | 'settings:get'
  | 'settings:update'
  | 'settings:getModels'
  | 'settings:getProviders';
