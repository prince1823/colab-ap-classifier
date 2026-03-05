import React, { useEffect, useMemo, useRef, useState } from 'react'
import { X, ChevronDown, ChevronUp, Filter } from 'lucide-react'
import '../../styles/ActiveFilters.css'

interface TableConfig {
  id: string
  title: string
  [key: string]: unknown
}

interface ActiveFiltersProps {
  activeFilters?: Record<string, unknown>
  filterState?: Record<string, unknown>
  tableLocalFilters?: Record<string, Record<string, unknown>>
  tables?: TableConfig[]
  onRemoveFilter: (key: string, value: string | null) => void
  onClearAll: () => void
  onRemoveLocalFilter?: (tableId: string, key: string, value: string | null) => void
  compact?: boolean
}

const ActiveFilters: React.FC<ActiveFiltersProps> = ({ activeFilters = {}, filterState = {}, tableLocalFilters = {}, tables = [], onRemoveFilter, onClearAll, onRemoveLocalFilter, compact = false }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  // When the user clicks a remove/clear action inside the dropdown, filters will change.
  // We don't want that change to auto-close the dropdown.
  const skipNextAutoCloseRef = useRef(false)
  // Map UI filter keys to human-readable labels
  const uiFilterLabels: Record<string, string> = {
    supplier: 'Supplier',
    classificationL1: 'Classification L1',
    classificationL2: 'Classification L2',
    classificationL3: 'Classification L3',
    classificationL4: 'Classification L4',
    glDescription: 'GL Description',
    company: 'Company',
    year: 'Year',
    quarter: 'Quarter',
    month: 'Month',
    costCenter: 'Cost Center',
    country: 'Country',
  }

  // Map backend/activeFilters keys to human-readable labels
  const backendFilterLabels: Record<string, string> = {
    supplier_name: 'Supplier',
    classification_l1: 'Classification L1',
    classification_l2: 'Classification L2',
    classification_l3: 'Classification L3',
    classification_l4: 'Classification L4',
    gl_description: 'GL Description',
    company: 'Company',
    year: 'Year',
    quarter: 'Quarter',
    month: 'Month',
    costCenter: 'Cost Center',
    country: 'Country',
  }

  const combined = useMemo(() => {
    // Collect filters from the UI filterState (handle arrays for OR logic)
    const uiFilters = Object.entries(filterState)
      .filter(([, value]: [string, unknown]) => {
        if (Array.isArray(value)) {
          return value.length > 0
        }
        return value && String(value).trim() !== ''
      })
      .flatMap(([key, value]: [string, unknown]) => {
        if (Array.isArray(value)) {
          return value.map((v: unknown) => ({
            key,
            label: uiFilterLabels[key] || key,
            value: String(v),
            isArrayItem: true,
            source: 'filterState' as const
          }))
        }
        return [{
          key,
          label: uiFilterLabels[key] || key,
          value: String(value),
          source: 'filterState' as const
        }]
      })

    // Collect filters from activeFilters (e.g., drag/drop, chart clicks) - handle arrays
    // Map backend keys to UI keys to avoid duplicates
    const keyMapping: Record<string, string> = {
      supplier_name: 'supplier',
      classification_l1: 'classificationL1',
      classification_l2: 'classificationL2',
      classification_l3: 'classificationL3',
      classification_l4: 'classificationL4',
      gl_description: 'glDescription'
    }

    const backendFilters = Object.entries(activeFilters)
      .filter(([key, value]: [string, unknown]) => {
        // Only show backend filters that aren't already in filterState
        const uiKey = keyMapping[key] || key
        const filterStateValue = (filterState as Record<string, unknown>)[uiKey]
        
        // Skip if this filter is already managed by filterState
        if (filterStateValue !== undefined && filterStateValue !== null && filterStateValue !== '') {
          if (Array.isArray(filterStateValue) && filterStateValue.length > 0) return false
          if (!Array.isArray(filterStateValue)) return false
        }
        
        if (Array.isArray(value)) {
          return value.length > 0
        }
        return value && String(value).trim() !== ''
      })
      .flatMap(([key, value]: [string, unknown]) => {
        if (Array.isArray(value)) {
          return value.map((v: unknown) => ({
            key,
            label: backendFilterLabels[key] || key,
            value: String(v),
            isArrayItem: true,
            source: 'activeFilters' as const
          }))
        }
        return [{
          key,
          label: backendFilterLabels[key] || key,
          value: String(value),
          source: 'activeFilters' as const
        }]
      })

    // Merge and de-duplicate filters (by label+value - prioritize filterState over activeFilters)
    type FilterEntry = { key: string; label: string; value: string; isArrayItem?: boolean; source: string; tableId?: string; tableTitle?: string }
    const combined: FilterEntry[] = []
    const seen = new Set<string>()

    // First add filterState filters
    uiFilters.forEach((f) => {
      const id = `${f.label}:${f.value}`
      if (!seen.has(id)) {
        seen.add(id)
        combined.push(f)
      }
    })

    // Then add activeFilters filters that don't duplicate filterState
    backendFilters.forEach((f) => {
      const id = `${f.label}:${f.value}`
      if (!seen.has(id)) {
        seen.add(id)
        combined.push(f)
      }
    })

    // Add local filters from tables (per-table filters from drag-drop)
    Object.entries(tableLocalFilters).forEach(([tableId, localFilters]: [string, Record<string, unknown>]) => {
      const table = tables.find((t: TableConfig) => t.id === tableId)
      const tableTitle = table ? table.title : `Table ${tableId}`

      Object.entries(localFilters).forEach(([key, value]: [string, unknown]) => {
        const label = backendFilterLabels[key] || key
        
        if (Array.isArray(value)) {
          value.forEach((v: unknown) => {
            const id = `${tableId}:${label}:${v}`
            if (!seen.has(id)) {
              seen.add(id)
              combined.push({
                key,
                label: `${label} (${tableTitle})`,
                value: String(v),
                isArrayItem: true,
                source: 'localFilters',
                tableId,
                tableTitle
              })
            }
          })
        } else if (value) {
          const id = `${tableId}:${label}:${value}`
          if (!seen.has(id)) {
            seen.add(id)
            combined.push({
              key,
              label: `${label} (${tableTitle})`,
              value: String(value),
              source: 'localFilters',
              tableId,
              tableTitle
            })
          }
        }
      })
    })

    return combined
  }, [activeFilters, backendFilterLabels, filterState, tableLocalFilters, tables, uiFilterLabels])

  // Prevent "click-through" / unintended opens when filters change (e.g., right after applying filters)
  const combinedKey = useMemo(() => {
    return combined.map(f => `${f.source}:${f.key}:${f.value}`).join('|')
  }, [combined])

  useEffect(() => {
    if (!compact) return

    if (skipNextAutoCloseRef.current) {
      skipNextAutoCloseRef.current = false
      return
    }

    setIsExpanded(false)
  }, [compact, combinedKey])

  if (combined.length === 0) {
    return null
  }

  if (compact) {
    return (
      <>
        {isExpanded && (
          <div
            className="active-filters-dropdown-backdrop"
            onClick={() => setIsExpanded(false)}
          />
        )}
        <div className="active-filters-container-compact">
          <div 
            className="active-filters-header-compact"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <div className="active-filters-title-section-compact">
              <span className="active-filters-count-compact">
                {combined.length} {combined.length === 1 ? 'filter' : 'filters'} active
              </span>
              <ChevronDown 
                size={14} 
                className={`active-filters-chevron ${isExpanded ? 'expanded' : ''}`}
              />
            </div>
            <button 
              className="clear-all-filters-btn-compact"
              onClick={(e) => {
                e.stopPropagation()
                skipNextAutoCloseRef.current = true
                onClearAll()
              }}
              title="Clear all filters"
            >
              <X size={14} />
            </button>
          </div>
          {isExpanded && (
            <div className="active-filters-dropdown-compact">
              <div className="active-filters-list-compact">
                {combined.map((filter, index) => (
                  <div key={`${filter.key}-${filter.value}-${index}`} className="active-filter-chip-compact">
                    <span className="filter-value-compact">{filter.key === 'classification_path' && filter.value.includes('|') ? filter.value.split('|').map(p => p.trim()).filter(Boolean).pop() : filter.value}</span>
                    <button
                      className="remove-filter-btn-compact"
                      onClick={() => {
                        skipNextAutoCloseRef.current = true
                        if (filter.source === 'localFilters' && onRemoveLocalFilter) {
                          onRemoveLocalFilter(filter.tableId!, filter.key, filter.isArrayItem ? filter.value : null)
                        } else {
                          onRemoveFilter(filter.key, filter.isArrayItem ? filter.value : null)
                        }
                      }}
                      title={`Remove ${filter.label} filter`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="active-filters-container">
      <div 
        className="active-filters-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="active-filters-title-section">
          <Filter size={14} className="filter-icon" />
          <span className="active-filters-title">
            {combined.length} {combined.length === 1 ? 'Filter' : 'Filters'} Active
          </span>
        </div>
        <div className="active-filters-actions">
          <button 
            className="clear-all-filters-btn"
            onClick={(e) => {
              e.stopPropagation()
              onClearAll()
            }}
            title="Clear all filters"
          >
            Clear All
          </button>
          <button 
            className="expand-toggle-btn"
            onClick={(e) => {
              e.stopPropagation()
              setIsExpanded(!isExpanded)
            }}
            title={isExpanded ? "Collapse filters" : "Expand filters"}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="active-filters-list">
          {combined.map((filter, index) => (
            <div key={`${filter.key}-${filter.value}-${index}`} className="active-filter-chip">
              <span className="filter-value">{filter.key === 'classification_path' && filter.value.includes('|') ? filter.value.split('|').map(p => p.trim()).filter(Boolean).pop() : filter.value}</span>
              <button
                className="remove-filter-btn"
                onClick={() => {
                  if (filter.source === 'localFilters' && onRemoveLocalFilter) {
                    onRemoveLocalFilter(filter.tableId!, filter.key, filter.isArrayItem ? filter.value : null)
                  } else {
                    onRemoveFilter(filter.key, filter.isArrayItem ? filter.value : null)
                  }
                }}
                title={`Remove ${filter.label} filter`}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default ActiveFilters
