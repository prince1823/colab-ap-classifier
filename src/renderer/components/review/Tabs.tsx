import React, { useState, useEffect } from 'react'
import { Plus, X, Edit2, Check, Sparkles } from 'lucide-react'
import ActiveFilters from './ActiveFilters'
import '../../styles/Tabs.css'

interface TabConfig {
  id: string
  label: string
  [key: string]: unknown
}

interface TableConfig {
  id: string
  title: string
  [key: string]: unknown
}

interface TabsProps {
  activeTab: string
  setActiveTab: (tab: string) => void
  tabs: TabConfig[]
  globalSearchTerm: string
  setGlobalSearchTerm: (term: string) => void
  showFilterPanel: boolean
  setShowFilterPanel: (show: boolean) => void
  activeFilters: Record<string, unknown>
  filterState: Record<string, unknown>
  filterPanelContent?: React.ReactNode
  showAddTableMenu: boolean
  setShowAddTableMenu: (show: boolean) => void
  availableColumns: string[]
  addTable: (column: string) => void
  hasTableFilters: boolean
  onClearAllTableFilters: () => void
  systemFeedbackEnabled: boolean
  setSystemFeedbackEnabled: (enabled: boolean) => void
  hasLowConfidenceRows: boolean
  tables: TableConfig[]
  onRemoveFilter: (key: string, value: string | null) => void
  onClearAll: () => void
}

const Tabs: React.FC<TabsProps> = ({
  activeTab,
  setActiveTab,
  tabs,
  // Search props
  globalSearchTerm,
  setGlobalSearchTerm,
  // Filter props
  showFilterPanel,
  setShowFilterPanel,
  activeFilters,
  filterState,
  filterPanelContent,
  // Add table props
  showAddTableMenu,
  setShowAddTableMenu,
  availableColumns,
  addTable,
  // Table filters
  hasTableFilters,
  onClearAllTableFilters,
  // System feedback props
  systemFeedbackEnabled,
  setSystemFeedbackEnabled,
  hasLowConfidenceRows,
  // Active filters props
  tables,
  onRemoveFilter,
  onClearAll,
}) => {
  const isTablesTab = activeTab === 'tables'

  return (
    <div className="tabs-container tabs-compact">
      <div className="tabs-header-content">
        {/* Active Filters - Compact Version */}
        <ActiveFilters
          activeFilters={activeFilters}
          filterState={filterState}
          onRemoveFilter={onRemoveFilter}
          onClearAll={onClearAll}
          compact={true}
        />

        <div className="tabs-actions tabs-actions-compact">
          {/* Clear All Table Filters Button */}
          {isTablesTab && hasTableFilters && (
            <button
              className="clear-all-table-filters-btn compact"
              onClick={onClearAllTableFilters}
              title="Clear all table filters"
            >
              <X size={12} />
              Clear
            </button>
          )}

          {/* System Feedback - text + icon + toggle; active = blue */}
          {isTablesTab && (
            <button
              className={`compact-control system-feedback-compact ${systemFeedbackEnabled ? 'active' : ''}`}
              onClick={() => setSystemFeedbackEnabled(!systemFeedbackEnabled)}
              title="System feedback on reclassification"
              role="switch"
              aria-checked={systemFeedbackEnabled}
            >
              <Sparkles size={14} className="system-feedback-icon" />
              <span className="system-feedback-label">System feedback</span>
              <span className="toggle-switch compact" aria-hidden="true">
                <span className="toggle-knob" />
              </span>
            </button>
          )}

          {/* Add Table - icon only */}
          {isTablesTab && (
            <div className="add-table-wrapper" style={{ position: 'relative' }}>
              <button
                className="add-table-icon-btn compact"
                onClick={() => setShowAddTableMenu(!showAddTableMenu)}
                disabled={!availableColumns || availableColumns.length === 0}
                title="Add table"
                aria-label="Add table"
              >
                <Plus size={14} />
              </button>

              {showAddTableMenu && availableColumns && availableColumns.length > 0 && (
                <>
                  <div
                    className="dropdown-backdrop"
                    onClick={() => setShowAddTableMenu(false)}
                  />
                  <div className="add-table-dropdown">
                    <div className="dropdown-header">Select Column</div>
                    {availableColumns.map(column => (
                      <button
                        key={column}
                        className="dropdown-item"
                        onClick={() => {
                          addTable(column)
                          setShowAddTableMenu(false)
                        }}
                      >
                        {column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Tabs
