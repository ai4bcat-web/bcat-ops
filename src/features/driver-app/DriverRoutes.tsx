import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { readScanIntent, scanIntentPath } from '@/features/driver-app/scanner/scanIntent'
import { useDriverAuth } from '@/features/driver-app/useDriverAuth'
import { DriverApp, ScanPage, SubmissionsPage, SettlementPage, PaperworkPage, TimeClockPage, AccountPage } from '@/features/driver-app/DriverApp'
import { useDriverProgramStatus } from '@/features/driver-app/useDriverProgram'
import type { DriverProgram } from '@/lib/driverProgram'
import DriverLoginPage from '@/features/driver-app/DriverLoginPage'
import DriverSignupPage from '@/features/driver-app/DriverSignupPage'
import { useTmsTheme } from '@/features/tms/tmsTheme'
import { useLegacySkin } from '@/lib/legacySkin'
import './driver.css'

function DriverLoading() {
  useTmsTheme()
  return (
    <div className="tms-driver tms-driver-inset flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-[color:var(--tms-primary)]" />
    </div>
  )
}

/**
 * Where the driver app lands when it is opened cold.
 *
 * `start_url` is `/driver`, and this used to send everyone to the settlement. That is right
 * for an ordinary launch and wrong for the one that matters: iOS discards the web view
 * while the phone's file picker is open, so a driver who taps Send on a load and goes to
 * pick their POD gets relaunched here — and watched their scan screen flash and vanish.
 *
 * If they were part-way through sending a document, they go back to it, on the right load.
 * Otherwise, the settlement as before.
 */
function DriverLanding({ program }: { program: DriverProgram }) {
  const intent = readScanIntent()
  const home = program === 'PAPERWORK' ? '/driver/paperwork' : '/driver/settlement'
  return <Navigate to={intent ? scanIntentPath(intent) : home} replace />
}

/**
 * /me failed, so we do not know which app to show this driver — and must not guess.
 * The server's own message is shown because it is the only clue anyone has: "Driver not
 * found" means their driver profile does not carry the email they signed in with, which
 * dispatch fixes in a minute once they know.
 */
function DriverProfileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  useTmsTheme()
  const { user, signOut } = useDriverAuth()
  return (
    <div className="tms-driver tms-driver-inset flex flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-lg font-semibold">We couldn't load your driver profile</p>
      <p className="text-[color:var(--tms-text-2)]">{message}</p>
      {user?.email && (
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{user.email}</span>. If this keeps
          happening, ask dispatch to check that email on your driver profile.
        </p>
      )}
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl bg-[color:var(--tms-primary)] px-5 py-2.5 font-semibold text-[color:var(--tms-on-primary)]"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-xl border border-input bg-card px-5 py-2.5 font-semibold text-foreground"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

export function DriverRoutes() {
  useLegacySkin()
  const { loading, isAuthenticated } = useDriverAuth()
  // Ask for the profile only once the session is known good; see useDriverProgram.
  const { program, error, retry } = useDriverProgramStatus(!loading && isAuthenticated)

  // Wait for the program before painting the shell: see useDriverProgram for why an Ivan
  // driver must never be shown the settlement tab even for a frame.
  if (loading || (isAuthenticated && program === null && !error)) {
    return <DriverLoading />
  }
  if (isAuthenticated && program === null && error) {
    return <DriverProfileError message={error} onRetry={retry} />
  }

  return (
    <Routes>
      <Route path="login" element={<DriverLoginPage />} />
      <Route path="signup" element={<DriverSignupPage />} />
      {isAuthenticated ? (
        <Route element={<DriverApp program={program ?? 'SETTLEMENT'} />}>
          {/* The settlement is the driver's home: their pay and every document
              action live there. Scanning is reached from a load, not landed on. */}
          {/* Where a relaunch lands. See DriverLanding. */}
          <Route index element={<DriverLanding program={program ?? 'SETTLEMENT'} />} />
          <Route path="scan" element={<ScanPage />} />
          <Route path="loads" element={<SubmissionsPage />} />
          <Route path="settlement" element={<SettlementPage />} />
          <Route path="paperwork" element={<PaperworkPage />} />
          <Route path="timeclock" element={<TimeClockPage />} />
          <Route path="account" element={<AccountPage />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/driver/login" replace />} />
      )}
    </Routes>
  )
}
