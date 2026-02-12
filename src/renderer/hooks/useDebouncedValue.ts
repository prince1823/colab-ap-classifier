import { useState, useEffect, useRef } from 'react'

/**
 * Returns a debounced version of the setter so the parent state updates
 * only after `delayMs` of no changes. The immediate value is for the
 * controlled input; the debounced value is what you use for filtering.
 * Only syncs from value -> immediate when value actually changes (e.g. external clear),
 * so parent re-renders don't wipe out the user's current typing.
 */
export function useDebouncedValue<T>(
  value: T,
  setValue: (v: T) => void,
  delayMs: number
): [T, (v: T) => void] {
  const [immediateValue, setImmediateValue] = useState(value)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevValueRef = useRef(value)

  // Sync immediate value only when external value actually changed (e.g. clear from parent)
  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value
      setImmediateValue(value)
    }
  }, [value])

  const setDebounced = (next: T) => {
    setImmediateValue(next)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      prevValueRef.current = next
      setValue(next)
    }, delayMs)
  }

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  return [immediateValue, setDebounced]
}
