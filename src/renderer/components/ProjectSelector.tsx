import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDownIcon, FolderOpenIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useWorkflowStore } from '../stores/workflowStore'


export default function ProjectSelector() {
  const { projectMetadata, loadProject, createProject, closeProject } = useWorkflowStore()
  const navigate = useNavigate()
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  const handleNewProject = async () => {
    if (!newProjectName.trim()) return
    setLoading(true)
    setError(null)
    try {
      await createProject(newProjectName.trim())
      setShowNewDialog(false)
      setNewProjectName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenProject = async () => {
    try {
      // project:open with no filePath triggers the native file dialog in the IPC handler
      await loadProject('')
      navigate('/project')
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open project')
    }
  }

  const handleCloseProject = async () => {
    await closeProject()
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-gray-100 transition-colors">
            <span className="font-medium text-gray-600">Project:</span>
            <span className="text-gray-800">
              {projectMetadata?.projectName || 'No Project'}
            </span>
            <ChevronDownIcon className="h-4 w-4 text-gray-400" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="z-50 min-w-[220px] rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
            sideOffset={5}
            align="start"
          >
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-700 outline-none hover:bg-blue-50 hover:text-blue-700"
              onSelect={() => setShowNewDialog(true)}
            >
              <PlusIcon className="h-4 w-4" />
              New Project
            </DropdownMenu.Item>

            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-700 outline-none hover:bg-blue-50 hover:text-blue-700"
              onSelect={handleOpenProject}
            >
              <FolderOpenIcon className="h-4 w-4" />
              Open Project...
            </DropdownMenu.Item>

            {projectMetadata && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-gray-200" />
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-700 outline-none hover:bg-red-50 hover:text-red-700"
                  onSelect={handleCloseProject}
                >
                  <XMarkIcon className="h-4 w-4" />
                  Close Project
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* New Project Dialog */}
      <Dialog.Root open={showNewDialog} onOpenChange={setShowNewDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold text-gray-900">
              New Project
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500">
              Enter a name for your new classification project.
            </Dialog.Description>

            <div className="mt-4">
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNewProject()}
                placeholder="Project name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
              {error && (
                <p className="mt-2 text-sm text-red-600">{error}</p>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowNewDialog(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleNewProject}
                disabled={loading || !newProjectName.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Open Project Error Dialog */}
      <Dialog.Root open={!!openError} onOpenChange={(open) => { if (!open) setOpenError(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold text-red-700">
              Failed to Open Project
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-600">
              {openError}
            </Dialog.Description>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setOpenError(null)}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                OK
              </button>
              <button
                onClick={() => {
                  setOpenError(null)
                  handleOpenProject()
                }}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Try Another
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
