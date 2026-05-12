import { NavLink } from 'react-router-dom'
import { Truck, CalendarDays, Table2, Users, History, Settings, LogOut, Command, MessageSquare, UserCog } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Avatar } from '@/components/ui/avatar'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/',         label: 'Calendar',  icon: CalendarDays,  pageKey: 'calendar'  },
  { to: '/grid',     label: 'Load Grid', icon: Table2,        pageKey: 'grid'      },
  { to: '/drivers',  label: 'Drivers',   icon: Users,         pageKey: 'drivers'   },
  { to: '/schedule', label: 'Schedules', icon: MessageSquare, pageKey: 'schedule'  },
  { to: '/audit',    label: 'Audit Log', icon: History,       pageKey: 'audit'     },
]

export function NavBar() {
  const { user, logout, isAdmin, hasPageAccess } = useAuth()

  return (
    <header className="h-14 shrink-0 flex items-center gap-3 px-6 bg-background border-b border-border">
      {/* Logo + wordmark */}
      <div className="flex items-center gap-2.5 shrink-0 mr-2">
        <div className="ds-logo-pill">
          <Truck className="size-3.5 text-white" />
          <span className="text-xs font-bold text-white tracking-tight select-none">BCAT OPS</span>
        </div>
      </div>

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* Nav links */}
      <nav className="flex items-center gap-0.5 min-w-0">
        {NAV_ITEMS.filter(({ pageKey }) => hasPageAccess(pageKey)).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            {({ isActive }) => (
              <span
                className={cn(
                  'inline-flex items-center gap-2 px-3 h-9 rounded-md text-sm font-medium transition-colors cursor-pointer select-none whitespace-nowrap',
                  isActive
                    ? 'bg-green-500 text-black'
                    : 'text-foreground/65 hover:text-foreground hover:bg-muted',
                )}
              >
                <Icon className={cn('size-4 shrink-0', isActive ? 'text-black' : 'text-foreground/50')} />
                {label}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Spacer */}
      {/* Users link — admin only */}
      {isAdmin && (
        <NavLink to="/users">
          {({ isActive }) => (
            <span className={cn(
              'inline-flex items-center gap-2 px-3 h-9 rounded-md text-sm font-medium transition-colors cursor-pointer select-none whitespace-nowrap',
              isActive ? 'bg-green-500 text-black' : 'text-foreground/65 hover:text-foreground hover:bg-muted',
            )}>
              <UserCog className={cn('size-4 shrink-0', isActive ? 'text-black' : 'text-foreground/50')} />
              Users
            </span>
          )}
        </NavLink>
      )}

      <div className="flex-1 min-w-4" />

      {/* Cmd+K trigger */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-2 text-sm text-muted-foreground hidden md:flex shrink-0 pr-2"
        aria-label="Open command palette (⌘K)"
      >
        <Command className="size-3.5 text-muted-foreground" />
        <span>Search…</span>
        <kbd className="ml-1 hidden select-none rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground md:inline-block">
          ⌘K
        </kbd>
      </Button>

      <Separator orientation="vertical" className="h-6 mx-2 hidden md:block" />

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-2 px-2 shrink-0 text-foreground/70 hover:text-foreground"
            aria-label="User menu"
          >
            <Avatar initials="D" size="sm" />
            <span className="text-sm font-medium hidden sm:block">dispatch</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground pb-1">
            {user?.email ?? 'dispatch'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled className="gap-2">
            <Settings className="size-4 text-muted-foreground" /> Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-destructive focus:text-destructive cursor-pointer"
            onClick={() => logout()}
          >
            <LogOut className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
