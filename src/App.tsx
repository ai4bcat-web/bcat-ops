import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppLayout } from '@/components/layout/AppLayout'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { GridPage } from '@/features/grid/GridPage'
import { DriversPage } from '@/features/drivers/DriversPage'
import { AuditPage } from '@/features/audit/AuditPage'
import { SchedulePage } from '@/features/schedule/SchedulePage'

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<CalendarPage />} />
            <Route path="/grid" element={<GridPage />} />
            <Route path="/drivers" element={<DriversPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
          </Route>
        </Routes>
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </BrowserRouter>
  )
}
