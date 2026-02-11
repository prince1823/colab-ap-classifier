import { NavLink, useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useWorkflowState } from '../contexts/WorkflowStateContext'

interface Tab {
  path: string
  label: string
  disabled: boolean
  tooltip: string
}

export default function WorkflowTabs() {
  const navigate = useNavigate()
  const workflowState = useWorkflowState()

  // Upload, Canonicalization, Data Review, Classification, Output: always clickable → show "Coming soon".
  // Review: only enabled when data is classified (actual review UI).
  const tabs: Tab[] = [
    {
      path: '/workflow/upload',
      label: 'Upload',
      disabled: false,
      tooltip: 'Coming soon',
    },
    {
      path: '/workflow/canonicalization',
      label: 'Canonicalization',
      disabled: false,
      tooltip: 'Coming soon',
    },
    {
      path: '/workflow/data-review',
      label: 'Data Review',
      disabled: false,
      tooltip: 'Coming soon',
    },
    {
      path: '/workflow/classification',
      label: 'Classification',
      disabled: false,
      tooltip: 'Coming soon',
    },
    {
      path: '/workflow/review',
      label: 'Review',
      disabled: !workflowState.hasClassifiedData,
      tooltip: workflowState.hasClassifiedData ? '' : 'Requires: Data classified',
    },
    {
      path: '/workflow/output',
      label: 'Output',
      disabled: false,
      tooltip: 'Coming soon',
    },
  ]

  const handleTabClick = (tab: Tab, e: React.MouseEvent) => {
    if (tab.disabled) {
      e.preventDefault()
      return
    }
    navigate(tab.path)
  }

  return (
    <div className="border-b border-gray-200 bg-white">
      <nav className="flex" aria-label="Workflow tabs">
        {tabs.map((tab) => {
          const content = (
            <NavLink
              to={tab.path}
              onClick={(e) => handleTabClick(tab, e)}
              className={({ isActive }) =>
                clsx(
                  'relative flex items-center justify-center border-b-2 px-6 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-blue-600 text-blue-600'
                    : tab.disabled
                    ? 'border-transparent text-gray-400 cursor-not-allowed'
                    : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
                )
              }
            >
              {tab.label}
            </NavLink>
          )

          if (tab.disabled && tab.tooltip) {
            return (
              <Tooltip.Provider key={tab.path} delayDuration={300}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg"
                      sideOffset={5}
                    >
                      {tab.tooltip}
                      <Tooltip.Arrow className="fill-gray-900" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            )
          }

          return <div key={tab.path}>{content}</div>
        })}
      </nav>
    </div>
  )
}
