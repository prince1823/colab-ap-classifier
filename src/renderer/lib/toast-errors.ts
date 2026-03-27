import { toast } from 'sonner'

/**
 * Show an error toast for a failed operation.
 * @param context - short description of what failed, e.g. "Failed to load taxonomy"
 * @param error - the caught error (Error, string, or unknown)
 */
export function showError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  toast.error(context, { description: message })
}

/**
 * Show a warning toast for non-blocking issues.
 * @param context - short description, e.g. "Settings"
 * @param message - the warning detail
 */
export function showWarning(context: string, message: string): void {
  toast.warning(context, { description: message })
}
