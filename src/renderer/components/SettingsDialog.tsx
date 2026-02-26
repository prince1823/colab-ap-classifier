import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * Minimal settings dialog — displays LLM provider/model info.
 * In v2, all LLM config lives in .env (CLASSIFIER_LLM_PROVIDER, CLASSIFIER_MODEL, API keys).
 * This dialog is read-only for now — tells users to update .env directly.
 */
export default function SettingsDialog({ open, onClose }: Props) {
  const [_provider] = useState('openrouter')
  const [_model] = useState('claude-3-5-haiku-latest')

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-900">Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className="rounded p-1 text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-700">
              LLM configuration is managed via environment variables in the <code className="font-mono">.env</code> file.
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Provider</label>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                {_provider}
              </div>
              <p className="mt-1 text-xs text-gray-500">Set via <code>CLASSIFIER_LLM_PROVIDER</code></p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Model</label>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                {_model}
              </div>
              <p className="mt-1 text-xs text-gray-500">Set via <code>CLASSIFIER_MODEL</code></p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">API Key</label>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                Configured via environment variable
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Set <code>OPENROUTER_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or <code>OPENAI_API_KEY</code>
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
