import { useState } from 'react'
import { FolderOpenIcon, PlusIcon, CircleStackIcon } from '@heroicons/react/24/outline'
import { useWorkflowStore } from '../stores/workflowStore'
import { ipc } from '../lib/ipc'

interface Props {
  onProjectReady: () => void
}

export default function LaunchModal({ onProjectReady }: Props) {
  const { createProject, loadProject, finalizeProjectOpen } = useWorkflowStore()
  const [mode, setMode] = useState<'choose' | 'new' | 'supplier-universe-setup'>('choose')
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!projectName.trim()) return
    setLoading(true)
    setError(null)
    try {
      const result = await createProject(projectName.trim())
      if (result.needsSupplierUniverseSetup) {
        setMode('supplier-universe-setup')
      } else {
        onProjectReady()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  const handleOpen = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadProject('')
      if (result.needsSupplierUniverseSetup) {
        setMode('supplier-universe-setup')
      } else {
        onProjectReady()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open project')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectExistingUniverse = async () => {
    setLoading(true)
    setError(null)
    try {
      const selected = await ipc.settings.selectSupplierUniverseFile()
      if (!selected) { setLoading(false); return }
      await ipc.settings.setSupplierUniversePath(selected)
      await finalizeProjectOpen()
      onProjectReady()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set supplier universe')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateNewUniverse = async () => {
    setLoading(true)
    setError(null)
    try {
      const path = await ipc.settings.createNewSupplierUniverse()
      if (!path) { setLoading(false); return }
      await finalizeProjectOpen()
      onProjectReady()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create supplier universe')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50">
      <div className="w-full max-w-lg rounded-xl bg-white p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-gray-900">AP Classifier</h1>
        <p className="mt-1 text-sm text-gray-500">
          {mode === 'supplier-universe-setup'
            ? 'Set up your supplier universe database to continue.'
            : 'Open an existing project or create a new one to get started.'}
        </p>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        {mode === 'choose' && (
          <div className="mt-6 grid grid-cols-2 gap-4">
            <button
              onClick={() => setMode('new')}
              disabled={loading}
              className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-gray-300 p-6 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
            >
              <PlusIcon className="h-8 w-8 text-gray-400" />
              <span className="text-sm font-medium text-gray-700">New Project</span>
            </button>
            <button
              onClick={handleOpen}
              disabled={loading}
              className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-gray-300 p-6 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
            >
              <FolderOpenIcon className="h-8 w-8 text-gray-400" />
              <span className="text-sm font-medium text-gray-700">Open Existing</span>
            </button>
          </div>
        )}

        {mode === 'new' && (
          <div className="mt-6">
            <label className="block text-sm font-medium text-gray-700">Project Name</label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="e.g., Q1 2026 AP Classification"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => { setMode('choose'); setError(null) }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                Back
              </button>
              <button
                onClick={handleCreate}
                disabled={loading || !projectName.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {mode === 'supplier-universe-setup' && (
          <div className="mt-6">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
              <CircleStackIcon className="h-4 w-4 text-gray-500" />
              Supplier Universe Database
            </div>
            <p className="text-xs text-gray-500 mb-4">
              This project needs a supplier database. It can be empty — you can populate it later.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleSelectExistingUniverse}
                disabled={loading}
                className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 p-5 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
              >
                <FolderOpenIcon className="h-6 w-6 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Select existing file</span>
                <span className="text-xs text-gray-400">.db file</span>
              </button>
              <button
                onClick={handleCreateNewUniverse}
                disabled={loading}
                className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 p-5 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
              >
                <PlusIcon className="h-6 w-6 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Create new database</span>
                <span className="text-xs text-gray-400">choose location</span>
              </button>
            </div>
            {loading && (
              <p className="mt-3 text-center text-xs text-gray-400">Setting up…</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
