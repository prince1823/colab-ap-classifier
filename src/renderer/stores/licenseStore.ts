import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set) => ({
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
    }),
    {
      name: 'c91-license',
      version: 1,
      partialize: (state) => ({
        status: state.status,
        isLicensed: state.isLicensed,
        isBlocked: state.isBlocked,
      }),
      // On rehydrate: derive isChecking from the cached status.
      // If we have a cached valid/check_failed status, don't block the UI while
      // the fresh IPC check runs. Still set isChecking=true for unlicensed so
      // the gate waits for the IPC result.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const { isLicensed, isBlocked } = deriveFlags(state.status)
        state.isLicensed = isLicensed
        state.isBlocked = isBlocked
        // Only show checking spinner if we have no usable cached status
        state.isChecking = state.status.state === 'unlicensed'
      },
    }
  )
)
