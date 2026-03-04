// Core IPC response envelope
export interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// IPC channel names — aligned to new architecture
export type IPCChannel =
  // Project (9 channels)
  | 'project:new'
  | 'project:open'
  | 'project:close'
  | 'project:getSetting'
  | 'project:setSetting'
  | 'project:deleteSetting'
  | 'project:getAllSettings'
  | 'project:getMetadata'
  | 'project:updateMetadata'
  // Ingest (5 channels)
  | 'ingest:selectFile'
  | 'ingest:parseCSV'
  | 'ingest:suggestMappings'
  | 'ingest:importCSV'
  | 'ingest:getUpload'
  // Classification (2 channels + 1 event)
  | 'classification:start'
  | 'classification:cancel'
  | 'classification:progress'
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
  | 'taxonomy:importFromFile'
  // Suppliers (5 channels + 1 event)
  | 'suppliers:list'
  | 'suppliers:update'
  | 'suppliers:confirm'
  | 'suppliers:researchAll'
  | 'suppliers:researchSingle'
  | 'suppliers:research:progress'
  // Rules (4 channels)
  | 'rules:list'
  | 'rules:create'
  | 'rules:update'
  | 'rules:delete'
  // Changelog (2 channels)
  | 'changelog:list'
  | 'changelog:revert'
  // Export (1 channel)
  | 'export:csv';
