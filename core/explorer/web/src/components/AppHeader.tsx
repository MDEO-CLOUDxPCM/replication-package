import { Link } from 'react-router';
import { Monitor, Moon, Sun, Database, CircleAlert, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useIndex } from '@/lib/api';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import { useTheme, type ThemePref } from '@/lib/theme';

export function AppHeader() {
  const { pref, setPref, theme } = useTheme();
  const idx = useIndex();
  const Icon = pref === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  const bad = idx.data?.sources.filter((s) => !s.ok || s.mode === 'recorded') ?? [];
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-card/80 px-4 backdrop-blur">
      <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
        <span className="grid grid-cols-2 gap-0.5" aria-hidden>
          <span className="size-2 rounded-[2px] bg-series-1" /><span className="size-2 rounded-[2px] bg-series-2" />
          <span className="size-2 rounded-[2px] bg-series-3" /><span className="size-2 rounded-[2px] bg-muted-foreground/60" />
        </span>
        Cut Explorer
      </Link>
      <WorkspaceToolbar />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label="Data sources">
              <Database className="size-4" />
              <span className="hidden sm:inline">{idx.data ? `${idx.data.runs.length} runs` : 'sources'}</span>
              {bad.length > 0 && <span className="size-1.5 rounded-full bg-[var(--status-warning)]" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[26rem] text-sm">
            <div className="mb-2 font-medium">Data sources</div>
            <ul className="space-y-2">
              {idx.data?.sources.map((s) => (
                <li key={s.id} className="flex gap-2">
                  {s.ok && s.mode !== 'recorded' ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--status-good)]" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />}
                  <div className="min-w-0">
                    <div><span className="font-medium">{s.id}</span> <span className="text-muted-foreground">· {s.kind} · {s.mode} · {s.runs} runs</span></div>
                    <div className="truncate text-xs text-muted-foreground" title={s.location}>{s.location}</div>
                    {s.message && <div className="text-xs text-muted-foreground">{s.message}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Theme"><Icon className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
              <DropdownMenuRadioItem value="system"><Monitor className="size-4" /> System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light"><Sun className="size-4" /> Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon className="size-4" /> Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
