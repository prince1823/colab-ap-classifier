import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import type { LicenseStatus, LicenseActivationResult } from '../../shared/types/license'

interface LicenseState {
  status: LicenseStatus
  isActivating: boolean
  activationError: string | null
  isChecking: boolean

  // Derived
  isLicensed: boolean
  isBlocked: boolean

  // Actions
  fetchStatus: () => Promise<void>
  activate: (key: string) => Promise<LicenseActivationResult>
  subscribeToStatusChanges: () => () => void
}

function deriveFlags(status: LicenseStatus) {
  const isLicensed = status.state === 'valid'
  const isBlocked =
    status.state === 'revoked' ||
    status.state === 'expired' ||
    status.state === 'unlicensed' ||
    (status.state === 'check_failed' && status.graceDeadline != null && Date.now() > status.graceDeadline)
  return { isLicensed, isBlocked }
}

export const useLicenseStore = create<LicenseState>()((set) => ({
  status: { state: 'unlicensed' },
  isActivating: false,
  activationError: null,
  isChecking: true,
  isLicensed: false,
  isBlocked: true,

  fetchStatus: async () => {
    try {
      const status = await ipc.license.getStatus()
      set({ status, activationError: null, isChecking: false, ...deriveFlags(status) })
    } catch (err) {
      // If IPC fails (e.g. main process not ready), keep current state
      set({ isChecking: false })
    }
  },

  activate: async (key: string) => {
    set({ isActivating: true, activationError: null })
    try {
      const result = await ipc.license.activate(key)
      set({
        status: result.status,
        isActivating: false,
        activationError: result.success ? null : (result.error || 'Activation failed'),
        ...deriveFlags(result.status),
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Activation failed'
      set({ isActivating: false, activationError: msg })
      return { success: false, status: { state: 'unlicensed' as const }, error: msg }
    }
  },

  subscribeToStatusChanges: () => {
    try {
      return ipc.license.onStatusChanged((status) => {
        set({ status, ...deriveFlags(status) })
      })
    } catch {
      // Outside Electron (browser dev), electronAPI doesn't exist
      return () => {}
    }
  },
}))
