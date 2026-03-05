import { useEffect } from 'react'

/**
 * Custom hook for keyboard shortcuts
 * 
 * @param {Object} shortcuts - Object mapping key combinations to handlers
 * @example
 * useKeyboardShortcuts({
 *   'ctrl+d': () => console.log('Delete'),
 *   'cmd+shift+f': () => console.log('Filter')
 * })
 */
export const useKeyboardShortcuts = (shortcuts: Record<string, (event: KeyboardEvent) => void>) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyParts = []
      
      if (event.ctrlKey || event.metaKey) {
        keyParts.push(event.ctrlKey ? 'ctrl' : 'cmd')
      }
      if (event.shiftKey) {
        keyParts.push('shift')
      }
      if (event.altKey) {
        keyParts.push('alt')
      }
      
      keyParts.push(event.key.toLowerCase())
      const keyCombo = keyParts.join('+')
      
      const handler = shortcuts[keyCombo]
      if (handler) {
        event.preventDefault()
        handler(event)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts])
}

export default useKeyboardShortcuts
