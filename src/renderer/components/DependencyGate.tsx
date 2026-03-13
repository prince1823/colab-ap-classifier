import { Link } from 'react-router-dom'

export interface GateCondition {
  met: boolean
  message: string
  linkTo: string
  linkLabel: string
}

interface Props {
  requires: GateCondition[]
  children: React.ReactNode
}

export default function DependencyGate({ requires, children }: Props) {
  const unmet = requires.filter((c) => !c.met)

  if (unmet.length === 0) return <>{children}</>

  return (
    <div className="flex flex-1 items-center justify-center p-12">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <span className="text-lg font-bold text-amber-600">!</span>
        </div>
        <h3 className="text-lg font-semibold text-gray-900">Prerequisites needed</h3>
        <div className="mt-4 space-y-3">
          {unmet.map((c, i) => (
            <div key={i} className="rounded-lg border border-gray-200 bg-white p-4 text-left">
              <p className="text-sm text-gray-700">{c.message}</p>
              <Link
                to={c.linkTo}
                className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline"
              >
                {c.linkLabel} &rarr;
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
