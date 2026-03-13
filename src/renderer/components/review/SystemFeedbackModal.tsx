import React, { useState } from 'react'
import { X, CheckCircle, FileText, Building2, List, AlertCircle, Sparkles, Edit2 } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import '../../styles/SystemFeedbackModal.css'

interface AffectedRow {
  row_index?: number
  index?: number
  spend_amount?: number | string
  [key: string]: unknown
}

interface FeedbackSuggestion {
  id: string
  type?: string
  proposedChange?: string
  proposal_text?: string
  affectedRows?: AffectedRow[]
  [key: string]: unknown
}

interface SystemFeedbackModalProps {
  feedbackSuggestions?: FeedbackSuggestion[]
  onClose: () => void
  onApprove?: (suggestion: FeedbackSuggestion) => void
  onReject?: (suggestion: FeedbackSuggestion) => void
  onEdit?: (id: string, text: string) => void
}

const SystemFeedbackModal: React.FC<SystemFeedbackModalProps> = ({ feedbackSuggestions = [], onClose, onApprove, onReject, onEdit }) => {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const handleEdit = (suggestion: FeedbackSuggestion) => {
    setEditingId(suggestion.id)
    setEditText(suggestion.proposedChange || suggestion.proposal_text || '')
  }

  const handleSaveEdit = (suggestion: FeedbackSuggestion) => {
    if (onEdit && editText.trim()) {
      onEdit(suggestion.id, editText)
    }
    setEditingId(null)
    setEditText('')
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
  }

  const getSuggestionIcon = (type: string) => {
    switch (type) {
      case 'taxonomy_description':
        return <FileText size={16} />
      case 'company_context':
        return <Building2 size={16} />
      case 'new_rule':
        return <List size={16} />
      case 'category_a_supplier':
        return <AlertCircle size={16} />
      default:
        return <Sparkles size={16} />
    }
  }

  const getSuggestionTypeLabel = (type: string) => {
    switch (type) {
      case 'taxonomy_description':
        return 'Taxonomy Description'
      case 'company_context':
        return 'Company Context'
      case 'new_rule':
        return 'New Rule'
      case 'category_a_supplier':
        return 'Category A Supplier'
      default:
        return 'Feedback'
    }
  }

  // Group suggestions by type
  const groupedSuggestions = feedbackSuggestions.reduce<Record<string, FeedbackSuggestion[]>>((acc, suggestion) => {
    const type = suggestion.type || 'other'
    if (!acc[type]) {
      acc[type] = []
    }
    acc[type].push(suggestion)
    return acc
  }, {})

  const typeOrder = ['taxonomy_description', 'company_context', 'new_rule', 'category_a_supplier', 'other']

  // Calculate total amount for a suggestion
  const calculateTotalAmount = (suggestion: FeedbackSuggestion) => {
    if (!suggestion.affectedRows || suggestion.affectedRows.length === 0) {
      return 0
    }
    return suggestion.affectedRows.reduce((total: number, row: AffectedRow) => {
      const amount = parseFloat(String(row.spend_amount || 0)) || 0
      return total + amount
    }, 0)
  }

  // Extract classification path from proposedChange text
  const extractClassificationPath = (proposedChange: string | null | undefined) => {
    if (!proposedChange) return null
    
    // Try to find path in quotes (e.g., "non clinical → facilities → ...")
    const quotedMatch = proposedChange.match(/"([^"]+)"/)
    if (quotedMatch) {
      return quotedMatch[1]
    }
    
    // Try to find path after "to" or "for" (e.g., ... to "path" or ... for "path")
    const toMatch = proposedChange.match(/(?:to|for)\s+"([^"]+)"/)
    if (toMatch) {
      return toMatch[1]
    }
    
    // Try to find path with arrow notation
    const arrowMatch = proposedChange.match(/([^→]+(?:→[^→]+)+)/)
    if (arrowMatch) {
      return arrowMatch[1].trim()
    }
    
    return null
  }

  // Format amount for display
  const formatAmount = (amount: number) => fmtAbbrev(amount)

  return (
    <>
      <div className="feedback-modal-backdrop" onClick={onClose} />
      <div className="feedback-modal">
        <div className="feedback-modal-header">
          <div className="feedback-modal-title">
            <Sparkles size={18} />
            <h3>System Feedback ({feedbackSuggestions.length})</h3>
          </div>
          <button className="feedback-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="feedback-modal-content">
          {feedbackSuggestions.length === 0 ? (
            <div className="feedback-empty-state">
              <Sparkles size={32} className="empty-icon" />
              <h4>No suggestions yet</h4>
              <p>Feedback is generated when you reclassify rows.</p>
            </div>
          ) : (
            typeOrder.map(type => {
              const suggestions = groupedSuggestions[type] || []
              if (suggestions.length === 0) return null

              return (
                <div key={type} className="feedback-group-compact">
                  <div className="feedback-group-header-compact">
                    {getSuggestionIcon(type)}
                    <h4>{getSuggestionTypeLabel(type)}</h4>
                    <span className="group-count-compact">{suggestions.length}</span>
                  </div>

                  {suggestions.map((suggestion: FeedbackSuggestion, idx: number) => (
                      <div key={suggestion.id || idx} className="feedback-item-compact">
                       {suggestion.affectedRows && suggestion.affectedRows.length > 0 && (
                         <div className="affected-rows-info">
                           <span className="rows-count-badge">{suggestion.affectedRows.length} row{suggestion.affectedRows.length !== 1 ? 's' : ''}</span>
                           {suggestion.affectedRows.length <= 5 && (
                             <span className="rows-preview">
                               {suggestion.affectedRows.map((row: AffectedRow, rowIdx: number) => {
                                 const rowNum = row.row_index !== undefined ? row.row_index : (row.index !== undefined ? row.index : rowIdx + 1)
                                 return (
                                   <React.Fragment key={rowIdx}>
                                     {rowIdx > 0 && <span className="row-separator">, </span>}
                                     <span className="row-preview-item">{rowNum}</span>
                                   </React.Fragment>
                                 )
                               })}
                             </span>
                           )}
                         </div>
                       )}

               <div className="feedback-proposed-compact">
                 {editingId === suggestion.id ? (
                   <div className="edit-container-compact">
                     <textarea
                       className="edit-textarea-compact"
                       value={editText}
                       onChange={(e) => setEditText(e.target.value)}
                       rows={3}
                       placeholder="Edit the proposed change..."
                     />
                     <div className="edit-actions-compact">
                       <button className="action-btn-secondary" onClick={handleCancelEdit}>
                         Cancel
                       </button>
                       <button className="action-btn-primary" onClick={() => handleSaveEdit(suggestion)}>
                         <CheckCircle size={14} />
                         Save
                       </button>
                     </div>
                   </div>
                 ) : (
                   <div className="proposed-text-compact">
                     <p>{suggestion.proposedChange || suggestion.proposal_text || 'No description provided'}</p>
                     <button
                       className="edit-btn-compact"
                       onClick={() => handleEdit(suggestion)}
                       title="Edit"
                     >
                       <Edit2 size={12} />
                     </button>
                   </div>
                 )}
               </div>

               <div className="feedback-actions-compact">
                 <button
                   className="action-btn-reject"
                   onClick={() => onReject && onReject(suggestion)}
                 >
                   <X size={14} />
                   Reject
                 </button>
                 <button
                   className="action-btn-approve"
                   onClick={() => onApprove && onApprove(suggestion)}
                 >
                   <CheckCircle size={14} />
                   Approve
                 </button>
               </div>
                    </div>
                  ))}
                </div>
              )
            })
          )}
        </div>

        <div className="feedback-modal-footer">
          <button className="close-all-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  )
}

export default SystemFeedbackModal
