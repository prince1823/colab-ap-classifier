import { useState } from 'react'
import { KeyIcon } from '@heroicons/react/24/outline'
import { useLicenseStore } from '../stores/licenseStore'

export default function LicenseModal() {
  const { status, isActivating, activationError, activate } = useLicenseStore()
  const [key, setKey] = useState('')

  const handleActivate = async () => {
    if (!key.trim() || isActivating) return
    await activate(key.trim())
  }

  const isRevoked = status.state === 'revoked' || status.state === 'expired'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <KeyIcon className="h-8 w-8 text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">License Required</h1>
            <p className="text-sm text-gray-500">
              {isRevoked
                ? 'Your license is no longer valid.'
                : 'Enter your license key to continue.'}
            </p>
          </div>
        </div>

        {status.message && isRevoked && status.message !== activationError && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {status.message}
          </div>
        )}

        {activationError && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {activationError}
          </div>
        )}

        <div className="mt-6">
          <label className="block text-sm font-medium text-gray-700">License Key</label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
            placeholder="C91-XXXX-XXXX-XXXX"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            autoFocus
            disabled={isActivating}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={handleActivate}
            disabled={isActivating || !key.trim()}
            className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isActivating ? 'Activating...' : 'Activate'}
          </button>
        </div>
      </div>
    </div>
  )
}
