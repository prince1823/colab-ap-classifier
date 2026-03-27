import { useEffect, type ReactNode } from 'react'
import { useLicenseStore } from '../stores/licenseStore'
import LicenseModal from './LicenseModal'

interface Props {
  children: ReactNode
}

// In browser-only dev mode (no Electron), skip the gate entirely
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

export default function LicenseGate({ children }: Props) {
  const { isBlocked, isChecking, fetchStatus, subscribeToStatusChanges } = useLicenseStore()

  useEffect(() => {
    if (!hasElectronAPI) return
    fetchStatus()
    const unsub = subscribeToStatusChanges()
    return unsub
  }, [fetchStatus, subscribeToStatusChanges])

  if (!hasElectronAPI) {
    return <>{children}</>
  }

  // Don't render anything until the initial license check completes
  if (isChecking) {
    return null
  }

  return (
    <>
      <div style={isBlocked ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}>
        {children}
      </div>
      {isBlocked && <LicenseModal />}
    </>
  )
}
