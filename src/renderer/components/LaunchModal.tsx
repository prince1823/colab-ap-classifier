import { useState } from 'react'
import { FolderOpenIcon, PlusIcon } from '@heroicons/react/24/outline'
import { useWorkflowStore } from '../stores/workflowStore'

interface Props {
  onProjectReady: () => void
}

export default function LaunchModal({ onProjectReady }: Props) {
  const { createProject, loadProject } = useWorkflowStore()
  const [mode, setMode] = useState<'choose' | 'new'>('choose')
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!projectName.trim()) return
    setLoading(true)
    setError(null)
    try {
      await createProject(projectName.trim())
      onProjectReady()
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
      await loadProject('')
      onProjectReady()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open project')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50">
      <div className="w-full max-w-lg rounded-xl bg-white p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-gray-900">AP Classifier</h1>
        <p className="mt-1 text-sm text-gray-500">
          Open an existing project or create a new one to get started.
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
      </div>
    </div>
  )
}
