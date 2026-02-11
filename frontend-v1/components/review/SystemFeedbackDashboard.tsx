import React, { useState } from 'react'
import { CheckCircle, X, Edit2, FileText, Building2, List, AlertCircle, Sparkles } from 'lucide-react'
import '../styles/SystemFeedbackDashboard.css'

const SystemFeedbackDashboard = ({ feedbackSuggestions = [], onApprove, onReject, onEdit }) => {
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')

  const handleEdit = (suggestion) => {
    setEditingId(suggestion.id)
    setEditText(suggestion.proposedChange || suggestion.proposal_text || '')
  }

  const handleSaveEdit = (suggestion) => {
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

  const getSuggestionIcon = (type) => {
    switch (type) {
      case 'taxonomy_description':
        return <FileText size={20} />
      case 'company_context':
        return <Building2 size={20} />
      case 'new_rule':
        return <List size={20} />
      case 'category_a_supplier':
        return <AlertCircle size={20} />
      default:
        return <Sparkles size={20} />
    }
  }

  const getSuggestionTypeLabel = (type) => {
    switch (type) {
      case 'taxonomy_description':
        return 'Taxonomy Description Change'
      case 'company_context':
        return 'Company Context Change'
      case 'new_rule':
        return 'New Rule Suggestion'
      case 'category_a_supplier':
        return 'Category A Supplier Suggestion'
      default:
        return 'Feedback Suggestion'
    }
  }

  // Group suggestions by type
  const groupedSuggestions = feedbackSuggestions.reduce((acc, suggestion) => {
    const type = suggestion.type || 'other'
    if (!acc[type]) {
      acc[type] = []
    }
    acc[type].push(suggestion)
    return acc
  }, {})

  const typeOrder = ['taxonomy_description', 'company_context', 'new_rule', 'category_a_supplier', 'other']

  if (feedbackSuggestions.length === 0) {
    return (
      <div className="system-feedback-dashboard">
        <div className="feedback-header">
          <h2>System Feedback</h2>
          <p className="feedback-subtitle">AI-generated suggestions for improving taxonomy and rules</p>
        </div>
        <div className="feedback-empty-state">
          <Sparkles size={48} className="empty-icon" />
          <h3>No suggestions yet</h3>
          <p>Feedback is generated when you reclassify rows with system feedback generation enabled.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="system-feedback-dashboard">
      <div className="feedback-header">
        <h2>System Feedback</h2>
        <p className="feedback-subtitle">Review and apply AI-generated suggestions</p>
        <div className="feedback-count-badge">
          {feedbackSuggestions.length} suggestion{feedbackSuggestions.length !== 1 ? 's' : ''} pending
        </div>
      </div>

      <div className="feedback-suggestions">
        {typeOrder.map(type => {
          const suggestions = groupedSuggestions[type] || []
          if (suggestions.length === 0) return null

          return (
            <div key={type} className="feedback-group">
              <div className="feedback-group-header">
                {getSuggestionIcon(type)}
                <h3>{getSuggestionTypeLabel(type)}</h3>
                <span className="group-count">{suggestions.length}</span>
              </div>

              {suggestions.map(suggestion => (
                <div key={suggestion.id} className="feedback-item">
                  <div className="feedback-item-header">
                    <div className="feedback-item-info">
                      <span className="feedback-id">#{suggestion.id}</span>
                      {suggestion.createdAt && (
                        <span className="feedback-date">
                          {new Date(suggestion.createdAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>

                  {suggestion.affectedRows && suggestion.affectedRows.length > 0 && (
                    <div className="affected-rows">
                      <strong>Affected Rows:</strong> {suggestion.affectedRows.length} row{suggestion.affectedRows.length !== 1 ? 's' : ''}
                      {suggestion.affectedRows.length <= 5 && (
                        <div className="row-list">
                          {suggestion.affectedRows.map((row, idx) => (
                            <span key={idx} className="row-badge">
                              Row {row.row_index !== undefined ? row.row_index : idx + 1}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="proposed-change">
                    <strong>Proposed Change:</strong>
                    {editingId === suggestion.id ? (
                      <div className="edit-container">
                        <textarea
                          className="edit-textarea"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={4}
                          placeholder="Edit the proposed change..."
                        />
                        <div className="edit-actions">
                          <button
                            className="save-btn"
                            onClick={() => handleSaveEdit(suggestion)}
                          >
                            <CheckCircle size={16} />
                            Save
                          </button>
                          <button
                            className="cancel-btn"
                            onClick={handleCancelEdit}
                          >
                            <X size={16} />
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="proposed-text">
                        <div className="editable-text-wrapper">
                          <pre className="editable-pre">
                            {suggestion.proposedChange || suggestion.proposal_text || 'No description provided'}
                          </pre>
                          <button
                            className="inline-edit-btn"
                            onClick={() => handleEdit(suggestion)}
                            title="Edit proposed change"
                          >
                            <Edit2 size={12} />
                          </button>
                        </div>
                        <button
                          className="edit-btn"
                          onClick={() => handleEdit(suggestion)}
                          title="Edit proposed change"
                        >
                          <Edit2 size={14} />
                          Edit
                        </button>
                      </div>
                    )}
                  </div>

                  {suggestion.currentValue && (
                    <div className="current-value">
                      <strong>Current Value:</strong>
                      <pre>{suggestion.currentValue}</pre>
                    </div>
                  )}

                  <div className="feedback-actions">
                    <button
                      className="approve-btn"
                      onClick={() => onApprove && onApprove(suggestion)}
                    >
                      <CheckCircle size={16} />
                      Approve
                    </button>
                    <button
                      className="reject-btn"
                      onClick={() => onReject && onReject(suggestion)}
                    >
                      <X size={16} />
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SystemFeedbackDashboard
