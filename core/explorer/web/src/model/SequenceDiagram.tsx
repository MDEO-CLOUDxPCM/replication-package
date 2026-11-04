import type { ReactNode } from 'react';
import { MECHANISM_STYLE, PALETTES, edgeColor } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/**
 * A small UML-style sequence diagram as inline SVG (Interactions tab): lifelines grouped by where they run (a service,
 * the gateway, a database server, the broker: one box per group of neighbouring lifelines), messages, notes on a
 * lifeline, and frames (alt with an else part, async for work that runs in the background). Sized by a viewBox, themed
 * by tokens.
 */

export type Mech = keyof typeof MECHANISM_STYLE;
/** a lifeline; `group` is where it runs (neighbouring lifelines with the same group share one box) */
export interface LaneDef { id: string; title: string; sub?: string; group?: string }
export type Step =
  /** a message; `remote` colours it as that mechanism across containers, `ret` dashes an answer, `async` opens the head */
  | { msg: [string, string]; label: string; ret?: boolean; remote?: Mech; async?: boolean }
  | { note: string; text: string; muted?: boolean }
  | { frame: 'alt' | 'async'; span: [string, string]; guard: string; then: Step[]; orElse?: Step[]; elseGuard?: string };

const W = 610;
const PAD = 60;
const LANE_H = 30;
const GROUP_H = 16;
const CHAR = 5.7; // width of a 10 px character, near enough for the boxes around notes

const noteH = (text: string) => 13 * text.split('\n').length + 4;

function height(steps: Step[]): number {
  return steps.reduce((h, s) => h + ('msg' in s ? 22 : 'note' in s ? 10 + noteH(s.text) : 18 + height(s.then) + (s.orElse ? 16 + height(s.orElse) : 0) + 6), 0);
}

export function SequenceDiagram({ lanes, steps }: { lanes: LaneDef[]; steps: Step[] }) {
  const { theme } = useTheme();
  const pal = PALETTES[theme];
  const X: Record<string, number> = Object.fromEntries(lanes.map((l, i) => [l.id, lanes.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (lanes.length - 1)]));
  const grouped = lanes.some((l) => l.group);
  const HEAD = (grouped ? GROUP_H : 0) + LANE_H + 4;
  const H = HEAD + 10 + height(steps) + 8;
  const groups: { label: string; from: string; to: string }[] = [];
  for (const l of lanes) {
    const g = groups[groups.length - 1];
    if (l.group && g && g.label === l.group && lanes[lanes.indexOf(l) - 1]?.group === l.group) g.to = l.id;
    else if (l.group) groups.push({ label: l.group, from: l.id, to: l.id });
  }
  const top = grouped ? GROUP_H + 2 : 2;
  const out: ReactNode[] = [];
  let y = HEAD + 10;
  let k = 0;
  const draw = (list: Step[]) => {
    for (const s of list) {
      if ('msg' in s) {
        const [a, b] = s.msg.map((l) => X[l]);
        const yy = y + 15;
        const color = s.remote ? edgeColor(pal, s.remote) : undefined;
        const dir = b > a ? 1 : -1;
        const cls = color ? undefined : 'stroke-foreground';
        out.push(
          <g key={k++}>
            <line x1={a} y1={yy} x2={s.async ? b - dir : b - dir * 5} y2={yy} className={cls} stroke={color} strokeWidth={s.remote ? 2 : 1.1} strokeDasharray={s.ret ? '4 3' : undefined} />
            {s.async
              ? <path d={`M${b - dir * 7},${yy - 4} L${b},${yy} L${b - dir * 7},${yy + 4}`} fill="none" className={cls} stroke={color} strokeWidth={1.4} />
              : <path d={`M${b},${yy} l${-dir * 6},-3.5 v7 z`} className={color ? undefined : 'fill-foreground'} fill={color} />}
            <text x={(a + b) / 2} y={yy - 4} textAnchor="middle" className="fill-foreground text-[10px]">{s.label}</text>
          </g>,
        );
        y += 22;
      } else if ('note' in s) {
        const lines = s.text.split('\n');
        const w = Math.max(...lines.map((l) => l.length)) * CHAR + 12;
        const h = noteH(s.text);
        const x = Math.min(Math.max(X[s.note] - w / 2, 2), W - 2 - w);
        out.push(
          <g key={k++}>
            <rect x={x} y={y + 4} width={w} height={h} rx={3} className={cn('stroke-border', s.muted ? 'fill-muted' : 'fill-card')} strokeWidth={1} />
            {lines.map((l, i) => <text key={i} x={x + w / 2} y={y + 4 + 12 + 13 * i} textAnchor="middle" className={cn('text-[10px]', s.muted ? 'fill-muted-foreground' : 'fill-foreground')}>{l}</text>)}
          </g>,
        );
        y += 10 + h;
      } else {
        const x0 = Math.max(3, X[s.span[0]] - 78);
        const x1 = Math.min(W - 3, X[s.span[1]] + 52);
        const top = y + 2;
        y += 18;
        draw(s.then);
        let mid: number | undefined;
        if (s.orElse) {
          mid = y + 4;
          y += 16;
          draw(s.orElse);
        }
        const bottom = y + 2;
        y += 6;
        const tag = s.frame;
        const tw = tag.length * 6 + 12;
        out.push(
          <g key={k++}>
            <rect x={x0} y={top} width={x1 - x0} height={bottom - top} className="fill-none stroke-muted-foreground" strokeWidth={0.8} strokeDasharray={s.frame === 'async' ? '5 3' : undefined} />
            <path d={`M${x0},${top} h${tw} v8 l-5,5 h${-(tw - 5)} z`} className="fill-muted stroke-muted-foreground" strokeWidth={0.8} />
            <text x={x0 + 4} y={top + 10} className="fill-foreground text-[8.5px] font-semibold">{tag}</text>
            <text x={x0 + tw + 6} y={top + 11} className="fill-muted-foreground text-[9px]">[{s.guard}]</text>
            {mid !== undefined && <>
              <line x1={x0} y1={mid} x2={x1} y2={mid} className="stroke-muted-foreground" strokeWidth={0.8} strokeDasharray="4 3" />
              <text x={x0 + 6} y={mid + 11} className="fill-muted-foreground text-[9px]">[{s.elseGuard ?? 'else'}]</text>
            </>}
          </g>,
        );
      }
    }
  };
  draw(steps);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: W * 1.15 }} role="img">
      {groups.map((g) => (
        <g key={`${g.label}|${g.from}`}>
          <rect x={X[g.from] - 57} y={1} width={X[g.to] - X[g.from] + 114} height={H - 2} rx={5} className="fill-muted/40 stroke-muted-foreground/50" strokeWidth={0.8} />
          <text x={(X[g.from] + X[g.to]) / 2} y={12} textAnchor="middle" className="fill-muted-foreground text-[9px] font-semibold">{g.label}</text>
        </g>
      ))}
      {lanes.map((l) => (
        <g key={l.id}>
          <line x1={X[l.id]} y1={top + LANE_H} x2={X[l.id]} y2={H - 4} className="stroke-border" strokeWidth={1} strokeDasharray="3 3" />
          <rect x={X[l.id] - 50} y={top} width={100} height={LANE_H} rx={4} className="fill-card stroke-border" strokeWidth={1} />
          <text x={X[l.id]} y={top + (l.sub ? 13 : 19)} textAnchor="middle" className="fill-foreground text-[10px] font-medium">{l.title}</text>
          {l.sub && <text x={X[l.id]} y={top + 24} textAnchor="middle" className="fill-muted-foreground text-[8.5px]">{l.sub}</text>}
        </g>
      ))}
      {out}
    </svg>
  );
}
