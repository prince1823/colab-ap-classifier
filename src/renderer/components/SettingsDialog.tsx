import { useState, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, CheckCircleIcon, ExclamationCircleIcon, FolderOpenIcon } from '@heroicons/react/24/outline'
import { ipc } from '../lib/ipc'
import { showWarning } from '../lib/toast-errors'
import type { LLMConfigResponse } from '../../shared/types/ipc-contract'

interface Props {
  open: boolean
  onClose: () => void
}

interface ValidationResult { valid: boolean; error?: string }

interface SettingsFormState {
  provider: string
  model: string
  apiKey: string
  isValidating: boolean
  validationResult: ValidationResult | null
  modelValidationResult: ValidationResult | null
  exaKey: string
  isValidatingExa: boolean
  exaValidationResult: ValidationResult | null
}

const PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const

const DEFAULT_FORM: SettingsFormState = {
  provider: 'openrouter',
  model: 'claude-3-5-haiku-latest',
  apiKey: '',
  isValidating: false,
  validationResult: null,
  modelValidationResult: null,
  exaKey: '',
  isValidatingExa: false,
  exaValidationResult: null,
}

function hasKeyForProvider(config: LLMConfigResponse, provider: string): boolean {
  if (provider === 'openrouter') return config.hasOpenRouterKey
  if (provider === 'anthropic') return config.hasAnthropicKey
  if (provider === 'openai') return config.hasOpenAIKey
  return false
}

export default function SettingsDialog({ open, onClose }: Props) {
  const [form, setForm] = useState<SettingsFormState>(DEFAULT_FORM)
  const [config, setConfig] = useState<LLMConfigResponse | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Supplier universe path state
  const [supplierResolvedPath, setSupplierResolvedPath] = useState<string>('')
  const [supplierPathError, setSupplierPathError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(DEFAULT_FORM)
    setSaveError(null)
    setSaveSuccess(false)
    setSupplierPathError(null)
    ipc.settings.getLLMConfig().then((cfg) => {
      setConfig(cfg)
      setForm((prev) => ({ ...prev, provider: cfg.provider, model: cfg.model }))
    }).catch((e) => showWarning('Settings', `Could not load LLM config: ${e instanceof Error ? e.message : String(e)}`))
    ipc.supplierUniverse.getPath().then((p) => setSupplierResolvedPath(p ?? '')).catch((e) => showWarning('Settings', `Could not load supplier universe path: ${e instanceof Error ? e.message : String(e)}`))
  }, [open])

  function handleProviderChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setForm((prev) => ({ ...prev, provider: e.target.value, apiKey: '', validationResult: null, modelValidationResult: null }))
  }

  function handleModelChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setForm((prev) => ({ ...prev, model: e.target.value, modelValidationResult: null }))
  }

  function handleApiKeyChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setForm((prev) => ({ ...prev, apiKey: e.target.value, validationResult: null }))
  }

  async function handleValidate(): Promise<void> {
    setForm((prev) => ({ ...prev, isValidating: true, validationResult: null, modelValidationResult: null }))
    try {
      // Validate key: use typed key if present, otherwise validate stored key
      const keyResult = form.apiKey.trim()
        ? await ipc.settings.validateApiKey(form.provider, form.apiKey.trim())
        : await ipc.settings.validateStoredApiKey(form.provider)
      setForm((prev) => ({ ...prev, validationResult: keyResult }))

      // Validate model only if key is valid
      if (keyResult.valid && form.model.trim()) {
        const modelResult = form.apiKey.trim()
          ? await ipc.settings.validateModel(form.provider, form.apiKey.trim(), form.model.trim())
          : await ipc.settings.validateStoredModel(form.provider, form.model.trim())
        setForm((prev) => ({ ...prev, isValidating: false, modelValidationResult: modelResult }))
      } else {
        setForm((prev) => ({ ...prev, isValidating: false }))
      }
    } catch (e) {
      setForm((prev) => ({
        ...prev,
        isValidating: false,
        validationResult: { valid: false, error: e instanceof Error ? e.message : 'Validation failed' },
      }))
    }
  }

  function handleExaKeyChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setForm((prev) => ({ ...prev, exaKey: e.target.value, exaValidationResult: null }))
  }

  async function handleValidateExa(): Promise<void> {
    setForm((prev) => ({ ...prev, isValidatingExa: true, exaValidationResult: null }))
    try {
      const result = form.exaKey.trim()
        ? await ipc.settings.validateExaKey(form.exaKey.trim())
        : await ipc.settings.validateStoredExaKey()
      setForm((prev) => ({ ...prev, isValidatingExa: false, exaValidationResult: result }))
    } catch (e) {
      setForm((prev) => ({
        ...prev,
        isValidatingExa: false,
        exaValidationResult: { valid: false, error: e instanceof Error ? e.message : 'Validation failed' },
      }))
    }
  }

  async function handleSaveExaKey(): Promise<void> {
    if (!form.exaKey.trim()) return
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      await ipc.settings.setExaKey(form.exaKey.trim())
      const updated = await ipc.settings.getLLMConfig()
      setConfig(updated)
      setForm((prev) => ({ ...prev, exaKey: '', exaValidationResult: null }))
      setSaveSuccess(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save Exa key')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSave(): Promise<void> {
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      await ipc.settings.setProvider(form.provider)
      await ipc.settings.setModel(form.model.trim() || 'claude-3-5-haiku-latest')
      if (form.apiKey.trim()) {
        await ipc.settings.setApiKey(form.provider, form.apiKey.trim())
      }
      // Refresh config to update "key is set" indicators
      const updated = await ipc.settings.getLLMConfig()
      setConfig(updated)
      setForm((prev) => ({ ...prev, apiKey: '', validationResult: null, modelValidationResult: null }))
      setSaveSuccess(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleBrowseSupplierUniverse(): Promise<void> {
    setSupplierPathError(null)
    try {
      const selected = await ipc.supplierUniverse.selectFile()
      if (!selected) return
      setSupplierResolvedPath(selected)
    } catch (e) {
      setSupplierPathError(e instanceof Error ? e.message : 'Failed to set path')
    }
  }

  const keyIsSet = config ? hasKeyForProvider(config, form.provider) : false

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white shadow-xl flex flex-col max-h-[85vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <Dialog.Title className="text-lg font-semibold text-gray-900">Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className="rounded p-1 text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 pb-2">
            <div className="space-y-4">
              {/* ── Classification Model ── */}
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Classification Model</h3>

              {/* Provider */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Provider</label>
                <div className="flex flex-wrap gap-2">
                  {PROVIDERS.map((p) => (
                    <label key={p} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="provider"
                        value={p}
                        checked={form.provider === p}
                        onChange={handleProviderChange}
                        className="accent-blue-600"
                      />
                      <span className="text-sm text-gray-700">{p}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Model</label>
                <input
                  type="text"
                  value={form.model}
                  onChange={handleModelChange}
                  placeholder="claude-3-5-haiku-latest"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                {form.modelValidationResult && (
                  <div
                    className={`mt-1 flex items-center gap-1 text-xs ${
                      form.modelValidationResult.valid ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {form.modelValidationResult.valid ? (
                      <CheckCircleIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ExclamationCircleIcon className="h-3.5 w-3.5" />
                    )}
                    {form.modelValidationResult.valid ? 'Model found' : (form.modelValidationResult.error ?? 'Model not found')}
                  </div>
                )}
              </div>

              {/* API Key */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  API Key
                  {keyIsSet && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-green-600">
                      <CheckCircleIcon className="h-3.5 w-3.5" />
                      currently set
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={handleApiKeyChange}
                  placeholder={keyIsSet ? 'Enter new key to replace…' : 'Enter API key…'}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                {form.validationResult && (
                  <div
                    className={`mt-1 flex items-center gap-1 text-xs ${
                      form.validationResult.valid ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {form.validationResult.valid ? (
                      <CheckCircleIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ExclamationCircleIcon className="h-3.5 w-3.5" />
                    )}
                    {form.validationResult.valid ? 'Key is valid' : (form.validationResult.error ?? 'Invalid key')}
                  </div>
                )}
                {(form.apiKey.trim() || keyIsSet) && (
                  <div className="mt-2">
                    <button
                      onClick={handleValidate}
                      disabled={form.isValidating || isSaving}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {form.isValidating ? 'Validating…' : 'Validate'}
                    </button>
                  </div>
                )}
              </div>

              {/* ── Exa Web Search ── */}
              <div className="border-t border-gray-200 pt-4">
                <h3 className="mb-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">Exa Web Search</h3>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    API Key
                    {config?.hasExaKey && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-green-600">
                        <CheckCircleIcon className="h-3.5 w-3.5" />
                        currently set
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={form.exaKey}
                    onChange={handleExaKeyChange}
                    placeholder={config?.hasExaKey ? 'Enter new key to replace…' : 'Enter Exa API key…'}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  {form.exaValidationResult && (
                    <div
                      className={`mt-1 flex items-center gap-1 text-xs ${
                        form.exaValidationResult.valid ? 'text-green-600' : 'text-red-600'
                      }`}
                    >
                      {form.exaValidationResult.valid ? (
                        <CheckCircleIcon className="h-3.5 w-3.5" />
                      ) : (
                        <ExclamationCircleIcon className="h-3.5 w-3.5" />
                      )}
                      {form.exaValidationResult.valid ? 'Key is valid' : (form.exaValidationResult.error ?? 'Invalid key')}
                    </div>
                  )}
                  {(form.exaKey.trim() || config?.hasExaKey) && (
                    <div className="mt-2">
                      <button
                        onClick={handleValidateExa}
                        disabled={form.isValidatingExa || isSaving}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {form.isValidatingExa ? 'Validating…' : 'Validate'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* ── Supplier Universe ── */}
              <div className="border-t border-gray-200 pt-4">
                <h3 className="mb-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">Supplier Universe</h3>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Database File</label>
                  <div
                    className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-600 overflow-x-auto whitespace-nowrap"
                    title={supplierResolvedPath}
                  >
                    {supplierResolvedPath || 'Not configured'}
                  </div>
                  <div className="mt-2">
                    <button
                      onClick={handleBrowseSupplierUniverse}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <FolderOpenIcon className="h-3.5 w-3.5" />
                      Change
                    </button>
                  </div>
                  {supplierPathError && (
                    <p className="mt-1 text-xs text-red-600">{supplierPathError}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-gray-200 px-6 py-3">
            <div>
              {saveSuccess && <p className="text-xs text-green-600">Settings saved.</p>}
              {saveError && <p className="text-xs text-red-600">{saveError}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
