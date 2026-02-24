import React from 'react'
import { Loader2 } from 'lucide-react'
import '../../styles/ReclassificationLoader.css'

const ReclassificationLoader = ({ rowCount, currentRow = 0 }) => {
  return (
    <div className="reclassification-loader-overlay">
      <div className="reclassification-loader">
        <Loader2 size={32} className="spinner" />
        <div className="loader-content">
          <h3>Reclassifying Transactions</h3>
          <p className="loader-status">
            {currentRow > 0 
              ? `Processing ${currentRow} of ${rowCount} rows...`
              : `Updating ${rowCount} row${rowCount !== 1 ? 's' : ''}...`
            }
          </p>
          {rowCount > 0 && (
            <div className="progress-bar">
              <div 
                className="progress-fill"
                style={{ width: `${currentRow > 0 ? (currentRow / rowCount) * 100 : 0}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ReclassificationLoader
