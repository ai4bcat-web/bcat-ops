import type { ComponentType, SVGProps } from 'react'
import { Suspense, lazy } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Clock, LayoutDashboard, Loader2, UserCircle, Wallet } from 'lucide-react'
import type { DriverProgram } from '@/lib/driverProgram'

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
const PaperworkPage = lazy(() => import('./paperwork/PaperworkPage').then((m) => ({ default: m.PaperworkPage })))
const TimeClockPage = lazy(() => import('./timeclock/TimeClockPage').then((m) => ({ default: m.TimeClockPage })))
import { OnTheClockBar } from './timeclock/OnTheClockBar'
import { DispatchBar } from './DispatchBar'
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

export function DriverApp({ program = 'SETTLEMENT' }: { program?: DriverProgram }) {
  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      {/* Only Ivan's employees punch a clock, so only they can have one running. */}
      <OnTheClockBar enabled={program === 'PAPERWORK'} />
      {/* The dispatch number, one tap from anywhere on the route. */}
      <DispatchBar />
      {/*
        * min-h-0 lets this actually shrink.
        *
        * A flex child defaults to min-height:auto, so a tall page made the <main> grow past
        * the shell instead of scrolling inside it, and the tab bar was pushed off the
        * bottom of the screen. The pages themselves used min-h-screen — 100vh inside a
        * container that is already the viewport minus an 80px nav — which guaranteed every
        * screen overflowed by exactly the height of the tab bar.
        */}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
{/* Two tabs, not four. Scanning is not a destination — it is something a driver
            does to a specific load, so it is reached from that load's row on the
            settlement. Four tabs made them hunt for which one held their paperwork. */}
        {/* One tab, named for whichever program this driver is on. An Ivan driver has no
            settlement to visit and an owner operator has no separate paperwork page — so
            the home tab IS their page, rather than two tabs where one is always empty. */}
        {program === 'PAPERWORK'
          ? <TabButton to="/driver/paperwork" icon={LayoutDashboard} label="Dashboard" />
          : <TabButton to="/driver/settlement" icon={Wallet} label="Settlement" />}
        {/* The clock is a tab only for Ivan's employees — owner operators do not punch one,
            and a dead tab is worse than no tab. */}
        {program === 'PAPERWORK' && <TabButton to="/driver/timeclock" icon={Clock} label="Hours" />}
        <TabButton to="/driver/account" icon={UserCircle} label="Account" />
      </nav>
    </div>
  )
}

// Exported for the parent router so children can be declared next to the lazy
// imports the tab bar depends on.
export { ScanPage, SubmissionsPage, SettlementPage, PaperworkPage, TimeClockPage, AccountPage }
