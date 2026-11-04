import { useRef, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { EChart, type EChartHandle, type OptionBuilder } from '@/charts/EChart';
import { ExportMenu } from './ExportMenu';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  subtitle?: ReactNode;
  build: OptionBuilder;
  height?: number;
  exportName: string;
  actions?: ReactNode;
  className?: string;
  onEvents?: Record<string, (params: any, chart: any) => void>;
  footer?: ReactNode;
  chartRef?: React.Ref<EChartHandle>;
}

/** a card holding one chart, with SVG/PDF export */
export function ChartCard({ title, subtitle, build, height = 260, exportName, actions, className, onEvents, footer, chartRef }: Props) {
  const ref = useRef<EChartHandle>(null);
  const setRef = (h: EChartHandle | null) => {
    (ref as React.MutableRefObject<EChartHandle | null>).current = h;
    if (typeof chartRef === 'function') chartRef(h);
    else if (chartRef) (chartRef as React.MutableRefObject<EChartHandle | null>).current = h;
  };
  return (
    <Card className={cn('gap-0 py-0 overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {actions}
          <ExportMenu name={exportName} getSvg={() => ref.current!.toSvg(title)} />
        </div>
      </div>
      <div className="px-2 pb-2">
        <EChart ref={setRef} build={build} height={height} onEvents={onEvents} />
      </div>
      {footer}
    </Card>
  );
}
