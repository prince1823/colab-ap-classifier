import { useState } from 'react'
import ProjectSelector from './ProjectSelector'
import SettingsDialog from './SettingsDialog'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'

export default function Header() {
  const [showSettings, setShowSettings] = useState(false)

  return (
    <>
      <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6 shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-gray-900">AP Classifier</h1>
          <div className="h-6 w-px bg-gray-300" />
          <ProjectSelector />
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          title="Settings"
        >
          <Cog6ToothIcon className="h-5 w-5" />
        </button>
      </header>
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
