/**
 * The Verify tab's view of what an operation causes (the packet's verify/causes.json, contract/verify.ts Causes): per family (fetch, effect step, calls, the
 * own schema) one row per interaction, the code's side beside the model's, each row checked on its own. A row's
 * target operation opens its own part, so the check walks downstream.
 */
import { CircleAlert } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { OwnData } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '@/components/LevelChip';
import { MechChip, Section } from '../shared';

/** an access to the home class's own data (accepts the older spelling `local`): shown with its fixed mechanism, a read sync, a write in transaction */
const OWN = new Set(['own', 'local']);
import type { Cause, CauseKind, Causes, Loc } from '@contract/verify';
import { useTexts } from '@/lib/packet';
import { isExternal, opKey, useVerifyInfo, type Trees } from './data';
import { statusOf, useMarks, type Markable, type Marks } from './marks';
import { base, type SourceSel } from './SourcePane';
import { patchUrl } from '@/lib/useWorkspace';
import type { InputModel, ModelRequest } from '@contract/types';
import { GraphqlDoc, requestsRunning } from './GraphqlDoc';

/** `self`: how the operation itself is reached (a field's own fetch, the root resolver's call by the gateway) */
export const CAUSE_FAMILY: Record<CauseKind, 'self' | 'own' | 'fetch' | 'effect' | 'call' | 'code'> = {
  root: 'self', fetched: 'self', reaction: 'self', calledBack: 'self', calledBy: 'self', scheduled: 'self', home: 'own', read: 'fetch', field: 'fetch', write: 'effect', event: 'effect', callback: 'effect', copy: 'effect', call: 'call', code: 'code',
};

/** a target; `request`: open it in that request's context (its rows of other requests hidden) */
const select = (key: string, request?: string) => patchUrl({ model: `verify:${key}`, mtab: null, vreq: request ?? null });

export function EvButtons({ ev, sel, onSelect, trees }: { ev: Loc[]; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined }) {
  const tx = useTexts();
  const info = useVerifyInfo();
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ev.map((l, i) => {
        const external = isExternal(l, trees);
        const on = !!sel && sel.path === l.path && sel.line === l.line;
        const text = `${base(l.path)}${l.line ? `:${l.line}` : ''}`;
        return external
          ? <span key={i} title={tx('verify.ev.external', { path: l.path, tree: info.label(l.repo) }) || `${l.path} (not in ${info.label(l.repo)})`} className="font-mono text-[10px] text-muted-foreground/70">{text}</span>
          : <button key={i} type="button" title={`${l.label ? `${l.label}: ` : ''}${l.path}${l.line ? `:${l.line}` : ''}`} onClick={(e) => { e.stopPropagation(); onSelect({ repo: l.repo, path: l.path, line: l.line }); }}
            className={cn('cursor-pointer rounded border px-1 font-mono text-[10px] leading-tight transition-colors', on ? 'border-amber-500/60 bg-amber-500/20 text-foreground' : 'text-muted-foreground hover:border-foreground/30 hover:text-foreground')}>{text}</button>;
      })}
    </span>
  );
}

const FAMILIES: { id: (typeof CAUSE_FAMILY)[CauseKind]; title: string; hint: string }[] = [
  { id: 'self', title: 'Reached as', hint: 'how the operation itself is reached: the root resolver of a request, a field fetched on its entry\'s objects, a reaction, a provider callback, a call of another operation' },
  { id: 'own', title: 'Home', hint: 'the class whose service runs it; where it is a decision, its options; its own reads and writes are rows of Fetch (sync, own data) and Effect step (in transaction, own data)' },
  { id: 'fetch', title: 'Fetch', hint: 'gets data the operation needs: reads of another class (the home\'s own reads: sync, own data), the fields resolved on its objects' },
  { id: 'effect', title: 'Effect step', hint: 'a step of the work, no answer needed: writes of another class (the home\'s own writes: in transaction, own data), event → reaction, provider callbacks, copy feeds (the publish that feeds a copy → the sites reading it)' },
  { id: 'call', title: 'Calls', hint: 'calls of other operations whose answer the operation needs: sync only when strict, else sync or a cache; with the level, its rules and the curated reason' },
  { id: 'code', title: 'In the code only', hint: 'a fact of the code the model has no interaction for (a payload read, a publish nothing reacts to, a call left out), with the reason: check the reason' },
];
const ITSELF = new Set(['self', 'own']);
const familyOf = (k: CauseKind) => CAUSE_FAMILY[k];

const TAG: Record<CauseKind, string> = { root: 'root resolver', fetched: 'fetched as', reaction: 'reaction', calledBack: 'provider callback', calledBy: 'called by', scheduled: 'scheduled', home: 'home', read: 'read', field: 'field', write: 'write', event: 'event', callback: 'provider callback', copy: 'copy feed', call: 'call', code: 'code' };

/** the marks of an operation's rows: how many are checked */
export function causeProgress(partKey: string, causes: Causes | undefined, marks: Marks) {
  let ok = 0, issue = 0;
  for (const c of causes?.rows ?? []) {
    const s = statusOf({ key: `${partKey}#${c.key}`, fp: c.fp }, marks[`${partKey}#${c.key}`]);
    if (s === 'ok') ok++; else if (s === 'issue') issue++;
  }
  return { ok, issue, all: causes?.rows.length ?? 0 };
}

function Target({ c, hasPart }: { c: Cause; hasPart: (k: string) => boolean }) {
  // a field's or root's row opens its target in the row's request
  const link = (key: string, label: string, cls?: string, request?: string) => (hasPart(key)
    ? <button type="button" onClick={(e) => { e.stopPropagation(); select(key, request); }} title={`check ${label}${request ? ` (in ${request})` : ''}`} className={cn('cursor-pointer rounded-sm underline decoration-border decoration-1 underline-offset-2 hover:decoration-foreground/60', cls)}>{label}</button>
    : <span className={cls}>{label}</span>);
  const muted = (t: string) => <span className="text-muted-foreground">{t}</span>;
  switch (c.kind) {
    case 'event': return <>{link(`event:${c.topic}`, c.topic!, 'text-muted-foreground')}{muted('→')}{c.op ? link(opKey(c.op), c.op, 'font-medium') : muted('no reaction')}</>;
    case 'root': return <>{muted('of')}{link(`req:${c.request}`, c.request!, 'font-medium')}{muted('— the gateway calls it')}</>;
    case 'fetched': return <>{muted('a field of')}{link(`req:${c.request}`, c.request!, 'font-medium')}{muted('on')}{c.op && link(opKey(c.op), c.op, undefined, c.request)}</>;
    case 'reaction': return <>{link(`event:${c.topic}`, c.topic!, 'font-medium')}{muted('raised by')}{c.op && link(opKey(c.op), c.op)}</>;
    case 'calledBack': return <>{muted('after')}{c.op && link(opKey(c.op), c.op, 'font-medium')}{muted('registers')}</>;
    case 'scheduled': return muted('by its schedule');
    case 'home': return <>{muted('runs in the service of')}{link(`class:${c.cls}`, c.cls!, 'font-medium')}{muted('today')}</>;
    case 'field': return link(opKey(c.op!), c.op!, 'font-medium', c.request);
    case 'copy': return <>{c.topic ? link(`event:${c.topic}`, c.topic, 'text-muted-foreground') : muted(c.cls!)}{muted('→')}{c.readers?.map((r) => <span key={r}>{link(opKey(r), r, 'font-medium')}</span>)}</>;
  }
  if (c.op) return link(opKey(c.op), c.op, 'font-medium');
  // a reference: the links of a class through it, not its rows
  if (c.via) return link(`ref:${c.via}`, c.via, 'font-medium');
  return link(`class:${c.cls}`, c.cls!, 'font-medium');
}

function CauseRow({ c, partKey, sel, onSelect, trees, hasPart, texts }: { c: Cause; partKey: string; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined; hasPart: (k: string) => boolean; texts?: InputModel['consistency'] }) {
  const tx = useTexts();
  const m: Markable = { key: `${partKey}#${c.key}`, fp: c.fp };
  const mark = useMarks((s) => s.marks[m.key]);
  const { toggleOk, toggleIssue } = useMarks();
  const status = statusOf(m, mark);
  const on = !!sel && c.ev.some((l) => l.path === sel.path && l.line === sel.line);
  const first = c.ev.find((l) => !isExternal(l, trees));
  return (
    <li onClick={first ? () => onSelect({ repo: first.repo, path: first.path, line: first.line }) : undefined}
      className={cn('space-y-0.5 border-b border-border/50 px-1 py-1', first && 'cursor-pointer hover:bg-accent/50', on && 'bg-amber-500/10', status === 'issue' && 'bg-amber-500/5', status === 'changed' && 'bg-sky-500/5')}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span onClick={(e) => e.stopPropagation()} className="inline-flex">
          <Checkbox checked={status === 'ok'} onCheckedChange={() => toggleOk(m)} aria-label="Checked" title={status === 'changed' ? 'checked earlier, but it changed since' : 'checked against the code'} className={cn('size-3.5', status === 'changed' && 'border-sky-500')} />
        </span>
        <span className={cn('rounded border px-1 text-[10px] leading-4 text-muted-foreground', c.kind === 'write' || c.kind === 'event' || c.kind === 'callback' || c.kind === 'copy' ? 'border-[color-mix(in_oklab,var(--series-5)_45%,transparent)]' : c.kind === 'field' || c.kind === 'fetched' || c.kind === 'root' ? 'border-[color-mix(in_oklab,var(--series-3)_45%,transparent)]' : '')}>{TAG[c.kind]}</span>
        <Target c={c} hasPart={hasPart} />
        {c.kind === 'event' && c.p !== undefined && <span className="rounded bg-muted px-1 text-[10px] tabular" title={tx('verify.cause.p') || 'raise probability'}>p {Number(c.p.toPrecision(3))}</span>}
        <LevelChip className="max-w-[8rem]" c={c.consistency} texts={texts} what={c.kind === 'call' || c.kind === 'calledBy' ? 'call' : 'read'} />
        {c.consistency?.lock && <LockMark />}
        {c.effect?.map((e) => <EffectCallChip key={e.to} to={e.to} rules={e.rules} reason={e.reason} texts={texts} />)}
        <span className="ml-auto inline-flex flex-wrap items-center gap-0.5" title={c.allowed.length ? (c.allowed.some((x) => OWN.has(x)) ? (c.allowed.length > 1 ? 'the options a design may choose: own data while its class is the home (the operation\'s own transaction), else the call site\'s mechanisms; highlighted: today\'s' : 'fixed: own data, no call site') : 'the mechanisms a design may choose; highlighted: today\'s') : undefined}>
          {c.kind === 'home'
            ? c.allowed.map((x) => <span key={x} className={cn('rounded border px-1.5 py-px text-[10.5px] leading-tight', x === c.today ? 'border-foreground/40 bg-card font-medium' : 'bg-card/50 text-muted-foreground opacity-60')}>{x}</span>)
            // own data with its mechanism (a read sync, a write in transaction), set apart from the call site's options
            : c.allowed.map((x, i) => (OWN.has(x)
              ? <span key={x} className="inline-flex items-center gap-0.5"><OwnData mode={c.kind === 'write' ? 'write' : 'read'} option={c.allowed.length > 1} active={c.allowed.length === 1 || x === c.today || c.today === undefined} />{i < c.allowed.length - 1 && <span aria-hidden className="mx-0.5 h-3 w-px bg-foreground/25" />}</span>
              : <MechChip key={x} m={x} active={x === c.today} muted={x !== c.today} />))}
        </span>
        <button type="button" onClick={(e) => { e.stopPropagation(); toggleIssue(m); }} aria-pressed={status === 'issue'} aria-label="Issue" title="mark an issue"
          className={cn('cursor-pointer rounded p-0.5', status === 'issue' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/40 hover:text-foreground')}><CircleAlert className="size-3.5" /></button>
      </div>
      <div className="grid grid-cols-[3rem_1fr] gap-x-2 pl-5 text-[10.5px] text-muted-foreground">
        <span>code</span>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">{c.code.length ? <span className="text-foreground/80">{c.code.join(' · ')}</span> : <span>—</span>}<EvButtons ev={c.ev} sel={sel} onSelect={onSelect} trees={trees} /></span>
        <span>model</span>
        <span className="text-foreground/80">{c.model.join(' · ')}</span>
      </div>
    </li>
  );
}

export function CausesView({ causes, partKey, request, requests, consistency, sel, onSelect, trees, hasPart }: { causes: Causes; partKey: string; request?: string; requests?: ModelRequest[]; consistency?: InputModel['consistency']; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined; hasPart: (k: string) => boolean }) {
  const tx = useTexts();
  const marks = useMarks((s) => s.marks);
  const pr = causeProgress(partKey, causes, marks);
  // in a request's context: only its rows of the request-bound kinds (root, a field's fetch, its fields)
  const perRequest = [...new Set(causes.rows.map((c) => c.request).filter(Boolean) as string[])];
  const ctx = request && perRequest.includes(request) ? request : undefined;
  const shown = causes.rows.filter((c) => !ctx || !c.request || c.request === ctx);
  const docs = requestsRunning(requests ?? [], partKey.slice(3)).filter((r) => !ctx || r.id === ctx);
  const hidden = causes.rows.length - shown.length;
  // a family's hint: the packet's (`verify.family.<id>.hint`), else the generic one
  const hint = (f: (typeof FAMILIES)[number]) => tx(`verify.family.${f.id}.hint`) || f.hint;
  const family = (f: (typeof FAMILIES)[number]) => {
    const rows = shown.filter((c) => familyOf(c.kind) === f.id);
    if (!rows.length) return null;
    return (
      <div key={f.id} className="pt-1">
        <div className="flex items-baseline gap-2 border-b pb-0.5"><span className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold">{f.title}</span><span className="min-w-0 truncate text-[10.5px] text-muted-foreground" title={hint(f)}>{hint(f)}</span></div>
        <ul>{rows.map((c) => <CauseRow key={c.key} c={c} partKey={partKey} sel={sel} onSelect={onSelect} trees={trees} hasPart={hasPart} texts={consistency} />)}</ul>
      </div>
    );
  };
  const itself = FAMILIES.filter((f) => ITSELF.has(f.id)), causesF = FAMILIES.filter((f) => !ITSELF.has(f.id));
  const anyCause = shown.some((c) => !ITSELF.has(familyOf(c.kind)));
  return (
    <>
      {perRequest.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
          <span className="text-muted-foreground">request</span>
          {perRequest.length > 1 && <button type="button" onClick={() => patchUrl({ vreq: null })} aria-pressed={!ctx} className={cn('cursor-pointer rounded border px-1.5 text-[10.5px]', !ctx ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground')}>all</button>}
          {perRequest.map((r) => <button key={r} type="button" onClick={() => patchUrl({ vreq: r })} aria-pressed={ctx === r} className={cn('cursor-pointer rounded border px-1.5 text-[10.5px]', ctx === r || perRequest.length === 1 ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground')}>{r}</button>)}
          <span className="text-[10.5px] text-muted-foreground">{ctx ? `the rows of ${ctx} only${hidden ? `; ${hidden} of other requests hidden` : ''}` : perRequest.length > 1 ? 'every request\'s rows; pick one to see the operation as it is done there' : ''}</span>
        </div>
      )}
      <Section title="Itself" right={`${pr.ok} of ${pr.all} checked${pr.issue ? ` · ${pr.issue} issues` : ''}`}>
        <p className="text-[11px] text-muted-foreground">How the operation itself is done: how it is reached, with the mechanisms of that call, and its own data. One row per interaction of the model (click a row for its source); a target opens its own operation.</p>
        {itself.map(family)}
        {!shown.some((c) => familyOf(c.kind) === 'self') && <p className="pt-1 text-[11px] text-muted-foreground">Not reached in the model: no request, field, event, callback or call reaches it.</p>}
        {docs.length > 0 && (
          <div className="pt-1">
            <div className="flex items-baseline gap-2 border-b pb-0.5"><span className="shrink-0 text-[11.5px] font-semibold">GraphQL</span><span className="min-w-0 truncate text-[10.5px] text-muted-foreground" title="the request's document as the workload sends it; highlighted: this operation's selection, what it reads for the request; a linked field is resolved by another operation (a row of What it causes)">the request's document; highlighted: what this operation reads for it</span></div>
            <div className="space-y-1.5 pt-1">
              {docs.map((r) => (
                <div key={r.id}>
                  {docs.length > 1 && <div className="text-[10.5px] text-muted-foreground">{r.id}</div>}
                  {r.document ? <GraphqlDoc r={r} op={partKey.slice(3)} /> : <p className="text-[11px] text-muted-foreground">No GraphQL document for {r.id} in the model{r.msa ? ` (msa ${r.msa})` : ''}.</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
      <Section title="What it causes">
        {causesF.map(family)}
        {!anyCause && <p className="text-[11px] text-muted-foreground">Nothing{ctx ? ` in ${ctx}` : ''}: no read, write, call or event.</p>}
      </Section>
    </>
  );
}
