import React, { useState } from 'react'
import { HelpCircle, X } from 'lucide-react'
import '../../styles/FilterHelpButton.css'

const FilterHelpButton = () => {
  const [isOpen, setIsOpen] = useState(false)

  const helpContent = [
    {
      title: 'Using Filters',
      items: [
        'Click the filter icon (🔍) on any table to open the filter panel',
        'Type in the search box to find specific items',
        'Check the boxes next to items you want to filter',
        'Filters are applied immediately to show matching transactions'
      ]
    },
    {
      title: 'Drag & Drop Filtering',
      items: [
        'Click and drag a row from one table to another table',
        'This applies the dragged value as a filter to the target table',
        'You can drag multiple selected rows (Ctrl/Cmd + Click to select)',
        'Filters from drag-drop are local to each table'
      ]
    },
    {
      title: 'Advanced Filters Panel',
      items: [
        'Use the Advanced Filters button in the header to open the filter panel',
        'Select multiple values from different categories (Supplier, Classification, etc.)',
        'Filters use OR logic within each category (AND logic between categories)',
        'Clear individual filters or use "Clear All" to reset everything'
      ]
    },
    {
      title: 'Table Filters',
      items: [
        'Each table has its own filter button in the header',
        'Table filters work independently and only affect that specific table',
        'Use the "Clear All Filters" button in the header to remove all table filters',
        'Table filters are shown with a badge indicating the number of active filters'
      ]
    },
    {
      title: 'Keyboard Shortcuts',
      items: [
        'Ctrl/Cmd + K: Apply selected rows as filters to current table',
        'Arrow Keys: Navigate between tables and rows',
        'Enter: Select/deselect current row',
        'Escape: Clear selection'
      ]
    }
  ]

  return (
    <>
      <button 
        className="filter-help-button"
        onClick={() => setIsOpen(true)}
        title="Help: How to use filters"
      >
        <HelpCircle size={18} />
        <span>Help</span>
      </button>

      {isOpen && (
        <>
          <div 
            className="help-modal-backdrop"
            onClick={() => setIsOpen(false)}
          />
          <div className="help-modal">
            <div className="help-modal-header">
              <h2>Filter Usage Guide</h2>
              <button 
                className="help-modal-close"
                onClick={() => setIsOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="help-modal-content">
              {helpContent.map((section, index) => (
                <div key={index} className="help-section">
                  <h3 className="help-section-title">{section.title}</h3>
                  <ul className="help-section-list">
                    {section.items.map((item, itemIndex) => (
                      <li key={itemIndex}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            
            <div className="help-modal-footer">
              <button 
                className="help-modal-close-btn"
                onClick={() => setIsOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export default FilterHelpButton
