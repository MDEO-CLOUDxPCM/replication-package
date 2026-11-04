/**
 * A read's or a call's consistency level (contract 1.13.0): **strict** (sync only), **stale-ok**
 * (sync, cache or copy, priced by O4), **immutable** (as stale-ok, no staleness cost), as one compact chip "strict · S2"
 * whose tooltip holds the level's text, the rules' texts and the curated reason. A lock read and an effect call have a
 * mark of their own. An access to the operation's own home class needs no justification: no chip (own data).
 * The texts are the case's (`InputModel.consistency`), else the generic ones of contract/consistency.ts.
 */
import type { Consistency, ConsistencyLevel, InputModel } from '@contract/types';
import { EFFECT_ABOUT, LEVEL_ABOUT, LOCK_ABOUT, levelText, reasonLines } from '@contract/consistency';
import { cn } from '@/lib/utils';

type Texts = InputModel['consistency'];

const STYLE: Record<ConsistencyLevel, string> = {
  strict: 'border-[color-mix(in_oklab,var(--status-warning)_65%,transparent)] text-foreground',
  'stale-ok': 'text-muted-foreground',
  immutable: 'border-[color-mix(in_oklab,var(--status-good)_60%,transparent)] text-foreground',
};

const CHIP = 'inline-block max-w-[12rem] shrink-0 truncate whitespace-nowrap rounded border px-1 align-middle text-[10px] leading-4';

/** the level's text, the rules' texts and the reason, as a tooltip */
export function levelTitle(c: Consistency, texts?: Texts, what = 'read'): string {
  const rules = (c.rules ?? []).map((r) => `${r}: ${texts?.rules?.[r] ?? '?'}`);
  const why = reasonLines(c.reason);
  return [
    `${c.level}: ${texts?.levels?.[c.level] ?? LEVEL_ABOUT[c.level]}`,
    ...(c.level === 'immutable' ? ['no staleness cost: O4 counts no stale reads for a site whose reads are all immutable'] : []),
    ...rules,
    ...(why.length ? ['', `why this ${what} is ${c.level}:`, ...why] : c.level === 'stale-ok' && !rules.length ? ['', `a ${what} that decides no write or check: not curated`] : []),
  ].join('\n');
}

/** `own`: an access to the home class (own data): nothing to justify, no chip */
export function LevelChip({ c, texts, own, what, className }: { c?: Consistency; texts?: Texts; own?: boolean; what?: string; className?: string }) {
  if (!c || own) return null;
  return <span data-level={c.level} title={levelTitle(c, texts, what)} className={cn(CHIP, STYLE[c.level], className)}>{levelText(c)}</span>;
}

/** a statement that only locks the class (a strict read, S5) */
export function LockMark({ className }: { className?: string }) {
  return <span data-lock title={LOCK_ABOUT} className={cn(CHIP, 'border-dashed text-muted-foreground', className)}>lock</span>;
}

/** an effect call (a registration with an external provider): sync only, E1 */
export function EffectCallChip({ rules = ['E1'], reason, to, texts, className }: { rules?: string[]; reason?: string; to?: string; texts?: Texts; className?: string }) {
  const title = [`${EFFECT_ABOUT}${to ? ` (${to})` : ''}`, ...rules.map((r) => `${r}: ${texts?.rules?.[r] ?? '?'}`), ...(reason ? ['', reason] : [])].join('\n');
  return <span data-effect title={title} className={cn(CHIP, 'border-[color-mix(in_oklab,var(--series-5)_55%,transparent)] text-foreground', className)}>effect · {rules.join(', ')}</span>;
}
