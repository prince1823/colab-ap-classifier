import React, { useState } from 'react'
import { X, CheckCircle, FileText, Building2, List, AlertCircle, Sparkles, Columns, Edit2 } from 'lucide-react'
import type { FeedbackRecommendation, FeedbackDetails } from '../../../shared/types/feedback'
import '../../styles/SystemFeedbackModal.css'

interface SystemFeedbackModalProps {
  recommendation: FeedbackRecommendation
  onClose: () => void
  onApply: (edited: FeedbackRecommendation) => void
  applying?: boolean
}

const ACTION_LABELS: Record<string, string> = {
  update_taxonomy_description: 'Update Taxonomy Description',
  update_supplier_info: 'Update Supplier Info',
  update_company_context: 'Update Company Context',
  update_column_priority: 'Update Column Priorities',
  create_rule: 'Create Rule',
  no_change: 'No Change Needed',
}

function getActionIcon(action: string) {
  switch (action) {
    case 'update_taxonomy_description': return <FileText size={16} />
    case 'update_supplier_info': return <AlertCircle size={16} />
    case 'update_company_context': return <Building2 size={16} />
    case 'update_column_priority': return <Columns size={16} />
    case 'create_rule': return <List size={16} />
    default: return <Sparkles size={16} />
  }
}

/**
 * Editable detail fields for each recommendation action type.
 */
function DetailEditor({
  details,
  onChange,
}: {
  details: FeedbackDetails
  onChange: (updated: FeedbackDetails) => void
}) {
  switch (details.type) {
    case 'update_taxonomy_description':
      return (
        <div className="detail-fields">
          <label className="detail-label">Taxonomy Path</label>
          <div className="detail-readonly">{details.nodePath}</div>
          <label className="detail-label">Current Description</label>
          <div className="detail-readonly">{details.currentDescription || '(none)'}</div>
          <label className="detail-label">Proposed Description</label>
          <textarea
            className="edit-textarea-compact"
            value={details.proposedDescription}
            onChange={e => onChange({ ...details, proposedDescription: e.target.value })}
            rows={3}
          />
        </div>
      )

    case 'update_supplier_info':
      return (
        <div className="detail-fields">
          <label className="detail-label">Supplier</label>
          <div className="detail-readonly">{details.supplierName}</div>
          <label className="detail-label">Field</label>
          <div className="detail-readonly">{details.field}</div>
          <label className="detail-label">Current Value</label>
          <div className="detail-readonly">{details.currentValue || '(none)'}</div>
          <label className="detail-label">Proposed Value</label>
          <input
            className="detail-input"
            value={details.proposedValue}
            onChange={e => onChange({ ...details, proposedValue: e.target.value })}
          />
        </div>
      )

    case 'update_company_context':
      return (
        <div className="detail-fields">
          <label className="detail-label">Field</label>
          <div className="detail-readonly">{details.field}</div>
          <label className="detail-label">Current Value</label>
          <div className="detail-readonly">{details.currentValue || '(none)'}</div>
          <label className="detail-label">Proposed Value</label>
          <textarea
            className="edit-textarea-compact"
            value={details.proposedValue}
            onChange={e => onChange({ ...details, proposedValue: e.target.value })}
            rows={3}
          />
        </div>
      )

    case 'update_column_priority':
      return (
        <div className="detail-fields">
          <label className="detail-label">Current Order</label>
          <div className="detail-readonly">{details.currentPriorities.join(', ') || '(none)'}</div>
          <label className="detail-label">Proposed Order (one per line)</label>
          <textarea
            className="edit-textarea-compact"
            value={details.proposedPriorities.join('\n')}
            onChange={e => onChange({ ...details, proposedPriorities: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
            rows={4}
          />
        </div>
      )

    case 'create_rule':
      return (
        <div className="detail-fields">
          <label className="detail-label">Rule Name</label>
          <input
            className="detail-input"
            value={details.name}
            onChange={e => onChange({ ...details, name: e.target.value })}
          />
          <label className="detail-label">Conditions</label>
          <div className="detail-readonly">
            {details.conditions.map((c, i) => (
              <div key={i}>{c.field} {c.operator} "{c.value}"</div>
            ))}
          </div>
          <label className="detail-label">Target Taxonomy Path</label>
          <input
            className="detail-input"
            value={details.targetTaxonomyPath}
            onChange={e => onChange({ ...details, targetTaxonomyPath: e.target.value })}
          />
        </div>
      )

    case 'no_change':
      return (
        <div className="detail-fields">
          <div className="detail-readonly">{details.explanation}</div>
        </div>
      )

    default:
      return null
  }
}

const SystemFeedbackModal: React.FC<SystemFeedbackModalProps> = ({
  recommendation,
  onClose,
  onApply,
  applying = false,
}) => {
  const [editedDetails, setEditedDetails] = useState<FeedbackDetails>(recommendation.details)

  const handleApply = () => {
    onApply({ ...recommendation, details: editedDetails })
  }

  return (
    <>
      <div className="feedback-modal-backdrop" onClick={onClose} />
      <div className="feedback-modal">
        <div className="feedback-modal-header">
          <div className="feedback-modal-title">
            <Sparkles size={18} />
            <h3>System Feedback</h3>
          </div>
          <button className="feedback-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="feedback-modal-content">
          {/* Action type badge */}
          <div className="feedback-group-compact">
            <div className="feedback-group-header-compact">
              {getActionIcon(recommendation.action)}
              <h4>{ACTION_LABELS[recommendation.action] || recommendation.action}</h4>
            </div>

            {/* Reasoning */}
            <div className="feedback-item-compact">
              <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
                {recommendation.reasoning}
              </p>
            </div>

            {/* Editable details */}
            <div className="feedback-item-compact">
              <DetailEditor details={editedDetails} onChange={setEditedDetails} />
            </div>
          </div>
        </div>

        <div className="feedback-modal-footer" style={{ gap: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="action-btn-secondary" onClick={onClose}>
            Dismiss
          </button>
          {recommendation.action !== 'no_change' && (
            <button
              className="action-btn-approve"
              onClick={handleApply}
              disabled={applying}
            >
              <CheckCircle size={14} />
              {applying ? 'Applying...' : 'Apply'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

export default SystemFeedbackModal
