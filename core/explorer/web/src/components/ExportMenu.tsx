import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { exportAs, slug } from '@/lib/export';

/** "Export" button: SVG or PDF of whatever `getSvg` returns (light theme) */
export function ExportMenu({ getSvg, name, size = 'icon' }: { getSvg: () => string | Promise<string>; name: string; size?: 'icon' | 'sm' }) {
  const run = async (kind: 'svg' | 'pdf') => {
    try {
      await exportAs(kind, await getSvg(), slug(name));
      toast.success(`Exported ${slug(name)}.${kind}`);
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={size === 'icon' ? 'icon' : 'sm'} className={size === 'icon' ? 'size-7 text-muted-foreground' : ''} aria-label={`Export ${name}`}>
          <Download className="size-3.5" />
          {size === 'sm' && <span>Export</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Export (light theme)</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run('svg')}>SVG</DropdownMenuItem>
        <DropdownMenuItem onClick={() => run('pdf')}>PDF</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
