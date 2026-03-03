// Core IPC response envelope
export interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ~30 IPC channel names — aligned to project flow (architecture.md)
export type IPCChannel =
  // Project (7 channels)
  | 'project:new'
  | 'project:open'
  | 'project:close'
  | 'project:getSetting'
  | 'project:setSetting'
  | 'project:deleteSetting'
  | 'project:getAllSettings'
  // Ingest (5 channels)
  | 'ingest:selectFile'
  | 'ingest:parseCSV'
  | 'ingest:suggestMappings'
  | 'ingest:importCSV'
  | 'ingest:getUpload'
  // Pipeline (3 channels + 1 event)
  | 'pipeline:start'
  | 'pipeline:approve'
  | 'pipeline:cancel'
  | 'pipeline:progress'
  // Transactions (4 channels)
  | 'transactions:query'
  | 'transactions:stats'
  | 'transactions:getColumns'
  | 'transactions:update'
  // Taxonomy (5 channels)
  | 'taxonomy:getNodes'
  | 'taxonomy:addNode'
  | 'taxonomy:updateNode'
  | 'taxonomy:deleteNode'
  | 'taxonomy:importFromColabip'
  // Suppliers (3 channels)
  | 'suppliers:list'
  | 'suppliers:update'
  | 'suppliers:research'
  // Rules (4 channels)
  | 'rules:list'
  | 'rules:create'
  | 'rules:update'
  | 'rules:delete'
  // Changelog (2 channels)
  | 'changelog:list'
  | 'changelog:revert'
  // Export (1 channel)
  | 'export:csv'
  // ColabIP (1 channel)
  | 'colabip:listTaxonomies';
