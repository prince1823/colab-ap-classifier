import { useState } from 'react'
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { ipc } from '../../lib/ipc'

interface Props {
  onFileSelected: (filePath: string) => void
}

export default function FileDropZone({ onFileSelected }: Props) {
  const [selecting, setSelecting] = useState(false)

  const handleClick = async () => {
    setSelecting(true)
    try {
      const filePath = await ipc.upload.selectFile()
      if (filePath) {
        onFileSelected(filePath)
      }
    } catch (e) {
      console.error('Failed to select file:', e)
    } finally {
      setSelecting(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={selecting}
      className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-12 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
    >
      {selecting ? (
        <>
          <svg className="mb-3 h-10 w-10 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-gray-600">Selecting file...</p>
        </>
      ) : (
        <>
          <ArrowUpTrayIcon className="mb-3 h-10 w-10 text-gray-400" />
          <p className="text-sm font-medium text-gray-700">Click to select a CSV file</p>
          <p className="mt-1 text-xs text-gray-500">Supports .csv files</p>
        </>
      )}
    </button>
  )
}
