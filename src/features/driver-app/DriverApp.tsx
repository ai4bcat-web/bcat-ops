import type { ComponentType, SVGProps } from 'react'
import { Suspense, lazy } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ClipboardList, Loader2, ScanLine, UserCircle, Wallet } from 'lucide-react'

// lucide-react does not export a named icon type; this describes the props we use.
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

// Mount points owned by sibling slices:
//   scanner/ScanPage.tsx            (default export)
//   SubmissionsPage.tsx             (default export)
//   settlement/SettlementPage.tsx   (named export SettlementPage)
//   AccountPage.tsx                 (named export AccountPage)
const ScanPage = lazy(() => import('./scanner/ScanPage'))
const SubmissionsPage = lazy(() => import('./SubmissionsPage'))
const SettlementPage = lazy(() => import('./settlement/SettlementPage').then((m) => ({ default: m.SettlementPage })))
const AccountPage = lazy(() => import('./AccountPage').then((m) => ({ default: m.AccountPage })))

function TabButton({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: IconComponent
  label: string
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `group flex flex-1 flex-col items-center justify-center gap-1 rounded-xl py-2 transition-colors ${
          isActive ? 'text-[#1ea8f3]' : 'text-slate-400 hover:text-slate-200'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              isActive ? 'bg-[#1ea8f3]/15' : 'group-hover:bg-slate-800'
            }`}
          >
            <Icon className="h-6 w-6" strokeWidth={isActive ? 2.5 : 2} />
          </div>
          <span className="text-[11px] font-semibold tracking-wide">{label}</span>
        </>
      )}
    </NavLink>
  )
}

export function DriverApp() {
  return (
    <div className="flex h-dvh flex-col bg-[#0b1220] text-white">
      <main className="flex-1 overflow-y-auto overscroll-contain">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-slate-400">
              <Loader2 className="h-8 w-8 animate-spin text-[#1ea8f3]" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <nav
        aria-label="Driver navigation"
        className="flex h-20 shrink-0 items-stretch border-t border-slate-800 bg-[#0b1220]/95 px-2 pt-1 backdrop-blur-sm"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 8px)' }}
      >
        <TabButton to="/driver/scan" icon={ScanLine} label="Scan" />
        <TabButton to="/driver/loads" icon={ClipboardList} label="Loads" />
        <TabButton to="/driver/settlement" icon={Wallet} label="Settlement" />
        <TabButton to="/driver/account" icon={UserCircle} label="Account" />
      </nav>
    </div>
  )
}

// Exported for the parent router so children can be declared next to the lazy
// imports the tab bar depends on.
export { ScanPage, SubmissionsPage, SettlementPage, AccountPage }
