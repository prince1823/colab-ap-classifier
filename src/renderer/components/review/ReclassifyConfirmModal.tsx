import React, { useState, useRef, useEffect } from 'react'
import { X, MessageSquare, ArrowRight, SkipForward } from 'lucide-react'
import '../../styles/ReclassifyConfirmModal.css'

interface ReclassifyConfirmModalProps {
  rowCount: number
  targetPath: string
  onConfirm: (feedbackText?: string) => void
  onCancel: () => void
}

const ReclassifyConfirmModal: React.FC<ReclassifyConfirmModalProps> = ({
  rowCount,
  targetPath,
  onConfirm,
  onCancel,
}) => {
  const [feedbackText, setFeedbackText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Auto-focus the textarea when modal opens
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  const displayPath = targetPath.replace(/^root\|/, '').replace(/\|/g, ' → ')

  const handleSubmit = () => {
    onConfirm(feedbackText.trim() || undefined)
  }

  const handleSkip = () => {
    onConfirm(undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <>
      <div className="reclass-confirm-backdrop" onClick={onCancel} />
      <div className="reclass-confirm-modal" onKeyDown={handleKeyDown}>
        <div className="reclass-confirm-header">
          <div className="reclass-confirm-title">
            <MessageSquare size={18} />
            <h3>Reclassify with Feedback</h3>
          </div>
          <button className="reclass-confirm-close" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>

        <div className="reclass-confirm-content">
          <div className="reclass-confirm-summary">
            <span className="reclass-row-count">{rowCount} row{rowCount !== 1 ? 's' : ''}</span>
            <ArrowRight size={14} className="reclass-arrow" />
            <span className="reclass-target-path">{displayPath}</span>
          </div>

          <div className="reclass-confirm-feedback">
            <label htmlFor="reclass-feedback-text" className="reclass-feedback-label">
              Why are you reclassifying? <span className="reclass-feedback-optional">(optional)</span>
            </label>
            <textarea
              ref={textareaRef}
              id="reclass-feedback-text"
              className="reclass-feedback-textarea"
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="e.g. 'This supplier always provides IT services, not consulting' or 'Our company pivoted to healthcare'"
              rows={3}
            />
            <p className="reclass-feedback-hint">
              Your feedback helps the AI learn and improve future classifications.
              Press <kbd>⌘</kbd>+<kbd>Enter</kbd> to submit.
            </p>
          </div>
        </div>

        <div className="reclass-confirm-footer">
          <button className="reclass-btn-skip" onClick={handleSkip}>
            <SkipForward size={14} />
            Skip &amp; Reclassify
          </button>
          <button className="reclass-btn-submit" onClick={handleSubmit}>
            Submit &amp; Reclassify
          </button>
        </div>
      </div>
    </>
  )
}

export default ReclassifyConfirmModal
