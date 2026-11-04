import { useMemo } from 'react';
import { Network } from 'lucide-react';
import type { Id, InputModel, ModelOperation, ModelSite } from '@contract/types';
import { JOIN_BLOCKER_LABEL, JOIN_BLOCKER_SHORT, effectShort } from '@contract/effects';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { patchUrl } from '@/lib/useWorkspace';
import { OwnData, PlacementBadge } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '@/components/LevelChip';
import { callConsistency, levelOf, readConsistency, reasonLines } from '@contract/consistency';
import { cn } from '@/lib/utils';
import { SeffTree, timingLabel } from './SeffTree';
import { callGraph } from './callGraph';
import { CallTree, PathLine } from './CallTree';
import { KindBadge, MechChip, ModelLink, RepoPath, Section, fmtN, fmtRate, sessionRates, useKindLabel, type DesignContext } from './shared';
import { useT } from './text';
import { accessName } from './accessName';

/** how today's code reaches an access (package A's words): `local` is its own service's database, not a mechanism */
const todayReach = (x: string) => (x === 'local' ? 'own service' : x);

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0">{children}</dd></div>
);

/**
 * the operation's effect steps: what it causes at other classes (writes, events, callbacks) with the mechanism, joined
 * or not and why, and the step form it reaches (envelope, work, commit); for a reaction, the steps whose work it is
 */
function EffectSteps({ model, op, ctx }: { model: InputModel; op: ModelOperation; ctx: DesignContext | null }) {
  // the steps of the chosen home's SEFF (the other options' sites are inert)
  const chosen = ctx?.design.decisions?.homes?.[op.id] ?? model.homes?.find((h) => h.op === op.id)?.written;
  const out = model.sites.filter((s) => s.op === op.id && s.family === 'effect' && (!s.home || s.home.class === chosen));
  const into = model.sites.filter((s) => s.family === 'effect' && s.callee === op.id);
  const t = useT();
  if (!out.length && !into.length) return null;
  const est = [...out, ...into].some((s) => s.effect?.step?.estimate);
  const row = (s: ModelSite, other: Id | undefined) => {
    const st = ctx?.design.decisions?.effects?.[s.id];
    const today = s.effect?.joined?.today;
    const step = s.effect?.step;
    return (
      <tr key={s.id} className="border-t border-border/50 align-top" title={s.id}>
        <td className="py-0.5 pr-2">{other ? <ModelLink target={other.includes('.') ? `op:${other}` : `class:${other}`}>{other}</ModelLink> : '–'} <span className="text-muted-foreground">{s.kind === 'access' ? 'write' : s.kind === 'event' ? `event ${s.event ?? ''}` : 'callback'}{s.effect?.p !== 1 ? `, p ${fmtN(s.effect?.p ?? 1, 3)}` : ''}</span></td>
        <td className="pr-2"><span className="inline-flex flex-wrap gap-0.5">{s.allowed.map((m) => <MechChip key={m} m={m} active={m === (ctx ? ctx.siteMech(s.id) : s.today)} />)}</span></td>
        <td className="pr-2 text-muted-foreground">{st ? effectShort(st) : today === true ? 'joined' : today ? <span title={JOIN_BLOCKER_LABEL[today]}>{today === 'chosen' ? 'own transaction' : JOIN_BLOCKER_SHORT[today]}</span> : '–'}{st && !st.joined && st.why && st.why !== 'chosen' ? <span title={JOIN_BLOCKER_LABEL[st.why]}> ({JOIN_BLOCKER_SHORT[st.why]})</span> : null}</td>
        <td className="text-right tabular text-muted-foreground">{step ? <span title={`step form ${step.seff}: envelope, work ${step.work}${step.commit ? `, commit ${step.commit} (${fmtN(step.commitMs ?? 0, 3)} ms wait)` : ', no commit'}`}>{fmtN(step.envelopeMs, 3)} ms{step.estimate ? '*' : ''}</span> : '–'}</td>
      </tr>
    );
  };
  return (
    <Section title="Effect steps" right={[t('model.op.effects.ref'), ctx ? `${ctx.label}'s state` : 'today'].filter(Boolean).join(' · ')}>
      <p className="text-[10.5px] text-muted-foreground">An effect step: an operation causes a change at another class. In transaction it joins the caller&apos;s transaction (a direct call: no envelope, commit or message) while caller and provider share a container and their schemas a database server; otherwise it runs B&apos;s step form in B&apos;s own transaction (envelope, work, commit), synchronously or as a message.{est && t('model.op.effects.estimate', ' * envelope: an estimate.')}</p>
      <table className="w-full">
        <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="font-medium">{out.length ? 'causes at' : 'step of'}</th><th className="font-medium">mechanism</th><th className="font-medium">joined</th><th className="text-right font-medium">envelope</th></tr></thead>
        <tbody>
          {out.map((s) => row(s, s.kind === 'access' ? s.class : s.callee))}
          {into.length > 0 && out.length > 0 && <tr><td colSpan={4} className="pt-1 text-[10.5px] text-muted-foreground">its work is a step of</td></tr>}
          {into.map((s) => row(s, s.op))}
        </tbody>
      </table>
    </Section>
  );
}

/** one operation: what it is, who reaches it at what rate, its timed parts and call sites, design A */
export function OperationDetail({ model, op, ctx, compact }: { model: InputModel; op: ModelOperation; ctx: DesignContext | null; compact?: boolean }) {
  const reqRate = useMemo(() => new Map(model.requests.map((r) => [r.id, r.rate])), [model]);
  const sess = useMemo(() => sessionRates(model, op), [model, op]);
  const opSites = useMemo(() => model.sites.filter((s) => s.op === op.id), [model, op]);
  const svcA = ctx?.opService(op);
  const ownSeffs = op.seffs.filter((s) => model.seffs.some((x) => x.id === s));
  // the home as a decision: the options, today's (written) and A's choice
  const homeDec = model.homes?.find((h) => h.op === op.id);
  const homeChoice = ctx?.design.decisions?.homes?.[op.id] ?? homeDec?.today ?? homeDec?.written;
  const timing = timingLabel(model);
  const mapped = op.accesses.some((a) => a.cpuMs > 0);
  const t = useT();
  const kind = useKindLabel();
  return (
    <div className="space-y-4 p-3 text-xs">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge op={op} />
          <h2 className="text-sm font-semibold">{op.name}</h2>
          <Badge variant="outline" className="h-5 text-[10.5px]">{kind.label(op.kind)}</Badge>
          <span className="font-mono text-[10.5px] text-muted-foreground">{op.id}</span>
          {!compact && <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-[11px]" onClick={() => patchUrl({ mtab: 'domain' })} title="the classes it touches in the domain diagram"><Network className="size-3" /> In the class diagram</Button>}
        </div>
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5">
          <Row k={t('model.homeClass', 'home class')}><ModelLink target={`class:${op.homeClass}`}>{op.homeClass}</ModelLink> <span className="text-muted-foreground">— it runs in the service the cut puts this class in</span></Row>
          <Row k="today's service">{op.service}</Row>
          {homeDec && <Row k="home (a decision)"><span className="inline-flex flex-wrap gap-x-1">{homeDec.options.map((o, i) => <span key={o.class}>{i > 0 && '· '}<ModelLink target={`class:${o.class}`} className={cn(o.class === homeChoice && 'font-medium')}>{o.class}</ModelLink>{o.class === homeDec.written ? <span className="text-muted-foreground"> (today)</span> : null}</span>)}</span> <span className="text-muted-foreground">{t('model.op.homeDecision', '— where the request enters, among the classes it writes in its transaction')}{ctx ? `; ${ctx.label}: ${homeChoice}` : ''}</span></Row>}
          {op.trigger && <Row k={op.kind === 'reaction' ? 'topic' : op.kind === 'callback' ? 'route' : 'GraphQL'}><code className="font-mono text-[10.5px]">{op.trigger}</code>{op.reactsTo && <span className="text-muted-foreground"> (domain event)</span>}</Row>}
          {op.entry && <Row k="entry point"><RepoPath path={op.entry} commit={model.commit} /></Row>}
          {op.feature && <Row k="feature">{op.feature}</Row>}
          <Row k="own work"><span className="tabular">{fmtN(op.cpuMs, 3)} ms</span> <span className="text-muted-foreground">CPU per execution ({timing})</span></Row>
          {!!op.mapCpuMs && <Row k="mapping, own data"><span className="tabular">{fmtN(op.mapCpuMs, 3)} ms</span> <span className="text-muted-foreground">{t('model.op.mapOwn', "CPU per execution for its home class's accesses (app-side persistence); the model's work action is own work + this")}</span></Row>}
          <Row k="rate"><span className="tabular font-medium">{fmtRate(op.rate)}</span> <span className="text-muted-foreground">at the design load ({fmtN(model.designSessionsPerS, 1)} sessions/s)</span></Row>
          {op.process && <Row k="process">{op.process.id} <span className="text-muted-foreground">({op.process.role})</span></Row>}
          {model.processes.filter((p) => p.transaction && p.trigger === op.id && (() => { const h = model.seffs.find((x) => x.id === p.transaction!.seff)?.home; return !h || h.class === homeChoice; })()).map((p) => (
            <Row key={p.id} k={t('model.op.transaction', 'transaction')}><code className="font-mono text-[10.5px]">{p.id}</code> <span className="text-muted-foreground">— its bound writes of {p.transaction!.writes.join(', ')} as steps; {p.styles.join(' / ')}, today {p.today ?? '?'}</span></Row>
          ))}
          {svcA && <Row k={`in ${ctx!.label}`}><span className="font-medium">{svcA.name}</span></Row>}
        </dl>
        {op.note && <p className="text-muted-foreground">{op.note}</p>}
      </div>

      <ReachedFrom model={model} op={op} ctx={ctx} />

      <Section title="Downstream: its call sites" right={ctx ? `mechanisms of ${ctx.label}` : "today's mechanisms"}>
        <p className="text-[10.5px] text-muted-foreground">Each link is one call of its SEFF: accesses to other classes, fields of the request's plan, events raised (one site per raise and reaction), provider callbacks, calls. Chips: the mechanisms the call site allows, {ctx ? "A's" : "today's"} highlighted; no hop / remote → service: whether caller and callee share a container {ctx ? 'in A' : 'today'} (the placement, not a mechanism); own data: the home class's own schema (fixed: a read sync, a write in transaction){t('model.op.sitesRef')}.</p>
        <div className="rounded-md border p-2"><CallTree model={model} roots={op.seffs.filter((s) => { const x = model.seffs.find((y) => y.id === s); return !!x && (!x.home || x.home.class === (ctx?.design.decisions?.homes?.[op.id] ?? model.homes?.find((h) => h.op === op.id)?.written)); })} ctx={ctx} entry={callGraph(model).entryOf.has(op.id) ? op.id : callGraph(model).reachedFrom.get(op.id)?.[0]} select={op.id} /></div>
      </Section>

      <EffectSteps model={model} op={op} ctx={ctx} />

      <Section title="Reached by" right={`${op.reach.length} request types`}>
        {op.reach.length ? (
          <table className="w-full">
            <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="font-medium">request type</th><th className="text-right font-medium" title="executions per request (plans, calls, events with their probabilities)">per request</th><th className="text-right font-medium">rate</th></tr></thead>
            <tbody>
              {op.reach.map((r) => (
                <tr key={r.request} className="border-t border-border/50">
                  <td className="py-0.5"><ModelLink target={`req:${r.request}`}>{r.request}</ModelLink></td>
                  <td className="text-right tabular">{fmtN(r.visits, 3)}</td>
                  <td className="text-right tabular">{fmtRate((reqRate.get(r.request) ?? 0) * r.visits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-muted-foreground">No request type reaches it.</p>}
        {sess.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {sess.map((x) => <span key={x.session.id} className="rounded border px-1.5 py-px"><ModelLink target={`session:${x.session.id}`}>{x.session.name}</ModelLink> <span className="tabular text-muted-foreground">{fmtRate(x.rate)}</span></span>)}
          </div>
        )}
      </Section>

      <Section title="Accesses" right="per execution">
        <table className="w-full">
          <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="font-medium">class or reference</th><th className="font-medium">mode</th><th className="text-right font-medium" title={t('model.op.stmtTitle', 'statements per execution')}>stmt</th><th className="pl-2 font-medium">shape</th><th className="text-right font-medium">db ms</th>{mapped && <th className="text-right font-medium" title={`mapping CPU per execution (${timing}): the home class's in the operation's work, another class's in that class's access SEFF (where the class runs)`}>map ms</th>}<th className="pl-2 font-medium">today</th>{ctx && <th className="font-medium">in A</th>}</tr></thead>
          <tbody>
            {op.accesses.map((a) => {
              const svc = ctx?.serviceOf.get(a.class);
              const site = opSites.find((s) => s.kind === 'access' && s.class === a.class && s.mode === a.mode);
              const across = svc && svcA && svc.id !== svcA.id;
              return (
                <tr key={`${a.class}|${a.mode}|${a.via ?? ''}`} className="border-t border-border/50 align-top">
                  <td className="py-0.5"><ModelLink target={`class:${a.class}`} className={cn(a.local && 'font-medium')} title={a.via ? t('model.op.viaTitle', 'the reference {{via}}: the links of {{cls}}, not its rows', { via: a.via, cls: a.class }) : undefined}>{accessName(a)}</ModelLink>{a.local && <span className="text-muted-foreground"> (home)</span>}{a.mode === 'read' && <> <LevelChip c={{ level: levelOf(a), rules: a.rules, reason: a.reason }} texts={model.consistency} own={a.local} />{a.lock && <> <LockMark /></>}</>}</td>
                  <td>{a.mode}</td>
                  <td className="text-right tabular">{fmtN(a.count)}</td>
                  <td className="pl-2 text-muted-foreground">{a.shape.toLowerCase().replace('_', ' ')}</td>
                  <td className="text-right tabular">{fmtN(a.dbMs, 3)}</td>
                  {mapped && <td className="text-right tabular">{fmtN(a.cpuMs, 3)}</td>}
                  <td className="pl-2 text-muted-foreground" title={t('model.op.todayTitle', "how today's code reaches it: own service (its own service's database), copy, call, payload")}>{a.today?.map(todayReach).join(', ') ?? ''}</td>
                  {ctx && <td>{a.local ? <OwnData mode={a.mode} /> : <span className="inline-flex flex-wrap items-center gap-1">{site ? <MechChip m={ctx.siteMech(site.id) ?? 'sync'} active /> : <MechChip m="sync" active title="no call site: sync only" />}{svc && svcA && <PlacementBadge together={!across} to={svc.name} where="A" />}</span>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {opSites.length > 0 && <p className="text-[10.5px] text-muted-foreground">{t('model.op.accessNote', "A read of another class may become a call, a cache or a local copy when the cut separates the classes; a write of another class is an effect step: in the operation's transaction (joined while co-located on one database server), a synchronous step or an asynchronous message. The allowed mechanisms per call site are in the tree below.")}</p>}
      </Section>

      <SyncOnly model={model} op={op} />

      {(op.calls.length > 0 || (op.effectCalls?.length ?? 0) > 0 || op.raises.length > 0 || op.reactsTo || op.bindings.length > 0) && (
        <Section title="Calls, events, bindings">
          <ul className="space-y-0.5">
            {op.calls.map((c) => <li key={c.callee}>calls <ModelLink target={`op:${c.callee}`}>{c.callee}</ModelLink> <span className="text-muted-foreground">× {fmtN(c.count)}{c.nestedIn ? ` · a field of ${c.nestedIn}'s call` : ''}</span> <LevelChip c={callConsistency(op, c.callee)} texts={model.consistency} what="call" /></li>)}
            {op.effectCalls?.map((e) => <li key={e.to}>registers with <code className="font-mono text-[10.5px]">{e.to}</code> <EffectCallChip to={e.to} rules={e.rules} reason={e.reason} texts={model.consistency} /></li>)}
            {op.raises.map((r) => {
              const ev = model.events.find((e) => e.id === r.event);
              return <li key={r.event}>raises <code className="font-mono text-[10.5px]">{r.event}</code> <span className="text-muted-foreground">p {fmtN(r.probability, 3)} → </span>{ev?.reactions.map((x, i) => <span key={x}>{i ? ', ' : ''}<ModelLink target={`op:${x}`}>{x}</ModelLink></span>)}</li>;
            })}
            {op.reactsTo && <li>reacts to <code className="font-mono text-[10.5px]">{op.reactsTo}</code> <span className="text-muted-foreground">from {model.events.find((e) => e.id === op.reactsTo)?.publishers.join(', ')}</span></li>}
            {op.bindings.map((b) => {
              const x = model.bindings.find((y) => y.id === b);
              return <li key={b}><Badge variant="outline" className="h-4 px-1 text-[9.5px]">{x?.kind}</Badge> {x?.classes.map((c, i) => <span key={c}>{i ? ' + ' : ''}<ModelLink target={`class:${c}`}>{c}</ModelLink></span>)} <span className="text-muted-foreground">{x?.kind === 'TRANSACTION' ? 'written in one transaction: a saga step when separated' : x?.kind === 'JOIN' ? 'one statement: two queries and an application join when separated' : 'a composition'}{t('model.op.bindingRef')}</span></li>;
            })}
          </ul>
        </Section>
      )}

      <Section title="How its SEFF expands" right="timed parts, ms of one full core">
        <details className="group">
          <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground">the SEFF part by part with demands (the base model, without middleware)</summary>
          <div className="space-y-1.5 pt-1.5">
            {ownSeffs.map((s) => {
              const seff = model.seffs.find((x) => x.id === s)!;
              const inert = !!seff.home && seff.home.class !== homeChoice;
              return <div key={s} className={cn('rounded-md border p-2', inert && 'opacity-55')} title={inert ? t('model.op.inertTitle', 'a home option not chosen: not reached, its sites are inert') : undefined}><SeffTree model={model} seff={s} ctx={ctx} label={`${seff.kind === 'request' ? `as the root resolver of ${seff.request}` : seff.request ? `as a field of ${seff.request}, with the fields resolved on its objects` : 'its SEFF'}${seff.home ? ` at ${seff.home.class} (${seff.home.class === homeChoice ? 'the chosen home' : 'an option not chosen'})` : ''}:`} /></div>;
            })}
          </div>
        </details>
      </Section>
    </div>
  );
}

/**
 * the reads and calls that are sync only because of their level, each with the curated rules and reason: the
 * strict reads of other classes (own data needs no justification), the strict calls, the effect calls
 */
function SyncOnly({ model, op }: { model: InputModel; op: ModelOperation }) {
  const t = useT();
  const reads = [...new Set(op.accesses.filter((a) => a.mode === 'read' && !a.local).map((a) => a.class))]
    .map((cls) => ({ cls, c: readConsistency(op, cls)! })).filter((x) => x.c.level === 'strict');
  const calls = op.calls.map((c) => ({ callee: c.callee, nestedIn: c.nestedIn, c: callConsistency(op, c.callee)! })).filter((x) => x.c.level === 'strict');
  const effects = op.effectCalls ?? [];
  if (!reads.length && !calls.length && !effects.length) return null;
  const sites = model.sites.filter((s) => s.op === op.id && s.kind === 'access' && s.mode === 'read');
  const why = (r?: string) => reasonLines(r).map((x, i) => <span key={i} className="block">{x}</span>);
  return (
    <Section title={t('model.op.syncOnly.title', 'Sync only by its level')} right={t('model.op.syncOnly.ref', 'consistency levels')}>
      <p className="text-[10.5px] text-muted-foreground">{t('model.op.syncOnly.intro', "Reads and calls whose consistency level leaves them synchronous: a strict read or call must see current data (no cache; a copy only where today's code reads its own store), an effect call changes something and reads nothing. Each with the rules and the curated reason; the rules are explained in Interactions.")}</p>
      <ul className="space-y-1">
        {reads.map(({ cls, c }) => {
          const copy = sites.some((s) => s.class === cls && s.allowed.includes('copy'));
          return (
            <li key={`r:${cls}`} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-2">
              <span className="flex flex-wrap items-center gap-1"><span className="text-muted-foreground">read</span><ModelLink target={`class:${cls}`}>{cls}</ModelLink><LevelChip c={c} texts={model.consistency} />{c.lock && <LockMark />}{copy && <span className="text-[10px] text-muted-foreground" title={t('model.op.syncOnly.copyTitle', "today's code serves it from the reader's own copy, written by the reader itself: sync or copy, never a cache")}>sync / copy</span>}</span>
              <span className="text-[10.5px] text-muted-foreground">{why(c.reason)}</span>
            </li>
          );
        })}
        {calls.map(({ callee, nestedIn, c }) => (
          <li key={`c:${callee}`} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-2">
            <span className="flex flex-wrap items-center gap-1"><span className="text-muted-foreground">call</span><ModelLink target={`op:${callee}`} className="truncate">{callee}</ModelLink><LevelChip c={c} texts={model.consistency} what="call" /></span>
            <span className="text-[10.5px] text-muted-foreground">{nestedIn && <span className="block">{t('model.op.syncOnly.nested', "a field of {{op}}'s invocation: its level is that call's", { op: nestedIn })}</span>}{why(c.reason)}</span>
          </li>
        ))}
        {effects.map((e) => (
          <li key={`e:${e.to}`} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-2">
            <span className="flex flex-wrap items-center gap-1"><span className="text-muted-foreground">call</span><code className="truncate font-mono text-[10.5px]">{e.to}</code><EffectCallChip to={e.to} rules={e.rules} reason={e.reason} texts={model.consistency} /></span>
            <span className="text-[10.5px] text-muted-foreground">{why(e.reason)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** who triggers an operation: an entry point itself, or the paths from the entry points down to it */
function ReachedFrom({ model, op, ctx }: { model: InputModel; op: ModelOperation; ctx: DesignContext | null }) {
  const g = callGraph(model);
  const e = g.entryOf.get(op.id);
  const from = g.reachedFrom.get(op.id) ?? [];
  const paths = useMemo(() => g.paths(op.id, 10), [g, op.id]);
  const t = useT();
  return (
    <Section title="Reached from" right={e ? 'entry point' : `${from.length} entry point${from.length === 1 ? '' : 's'}`}>
      {e && (
        <p>
          {e.kind === 'request' ? <>An entry point: the root resolver of {e.roots.map((r, i) => <span key={r.seff}>{i ? ', ' : ''}<ModelLink target={`req:${r.request}`}>{r.request}</ModelLink></span>)} (a user's request through the gateway).</>
            : e.kind === 'callback' ? <>An entry point: the external provider calls it back over HTTP{from.length ? '; in the model it follows the requests below through an asynchronous callback site' : ''}.</> : <>An entry point: a scheduled job.</>}
        </p>
      )}
      {!e && <p className="text-muted-foreground">{t('model.op.downstreamOp', 'A downstream operation')}: its own home class, accesses and SEFF, run only through the call sites below; {from.length > 1 ? `shared by ${from.length} entry points` : 'one entry point'}.</p>}
      {paths.length > 0 && (
        <ul className="space-y-1">
          {paths.map((p, i) => <li key={i} className="rounded-md border px-2 py-1"><PathLine model={model} entry={p.entry} links={p.links} ctx={ctx} /></li>)}
        </ul>
      )}
      {paths.length >= 10 && <p className="text-[10.5px] text-muted-foreground">the first 10 paths</p>}
    </Section>
  );
}

/** one domain class: what it is, its references, who reads and writes it, design A */
export function ClassDetail({ model, cls, ctx }: { model: InputModel; cls: Id; ctx: DesignContext | null }) {
  const c = model.classes.find((x) => x.id === cls);
  const out = model.references.filter((r) => r.from === cls);
  const inc = model.references.filter((r) => r.to === cls);
  const anchored = model.operations.filter((o) => o.homeClass === cls);
  const users = useMemo(() => model.operations.flatMap((o) => o.accesses.filter((a) => a.class === cls).map((a) => ({ op: o, a }))).sort((x, y) => y.op.rate - x.op.rate), [model, cls]);
  const events = model.events.filter((e) => e.payload.includes(cls));
  const bindings = model.bindings.filter((b) => b.classes.includes(cls));
  const t = useT();
  if (!c) return <p className="p-3 text-xs text-muted-foreground">No class {cls}.</p>;
  const svc = ctx?.serviceOf.get(cls);
  const mates = svc ? ctx!.design.decisions!.services.find((s) => s.id === svc.id)?.classes.filter((x) => x !== cls) ?? [] : [];
  const sitesIn = model.sites.filter((s) => s.class === cls);
  return (
    <div className="space-y-4 p-3 text-xs">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{c.id}</h2><Badge variant="outline" className="h-5 text-[10.5px]">today: {c.service}</Badge></div>
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5">
          <Row k="stored in">{c.table ?? c.storage}{c.rowBytes ? <span className="text-muted-foreground"> · {c.rowBytes} B per row</span> : null}</Row>
          {c.evidence && <Row k="defined at"><RepoPath path={c.evidence} commit={model.commit} /></Row>}
          <Row k="in the model"><span className="font-mono text-[10.5px]">{c.component}</span> <span className="text-muted-foreground">(its operations' SEFFs) and</span> <span className="font-mono text-[10.5px]">{c.schema}</span> <span className="text-muted-foreground">{t('model.class.placed', '(its schema), placed independently')}</span></Row>
          {svc && <Row k={`in ${ctx!.label}`}><span className="font-medium">{svc.name}</span>{mates.length > 0 && <span className="text-muted-foreground"> with {mates.join(', ')}</span>}; schema on <span className="font-mono text-[10.5px]">{ctx!.serverOf(cls)}</span></Row>}
        </dl>
        {c.note && <p className="text-muted-foreground">{c.note}</p>}
        <div className="flex flex-wrap gap-1 pt-1">{c.attributes.map((a) => <code key={a} className="rounded bg-muted px-1 font-mono text-[10.5px]">{a}</code>)}</div>
      </div>
      <Section title="References">
        <ul className="space-y-0.5">
          {out.map((r) => <li key={r.id}><span className="font-mono text-[10.5px]">{r.name}</span> → <ModelLink target={`class:${r.to}`}>{r.to}</ModelLink> <span className="text-muted-foreground">{r.kind}{r.upper < 0 ? ', many' : ''}{r.snapshot ? ', snapshot' : ''}{r.storage ? ` · ${r.storage}` : ''}{r.crossServiceToday ? ' · across services today' : ''}</span></li>)}
          {inc.map((r) => <li key={r.id}><ModelLink target={`class:${r.from}`}>{r.from}</ModelLink><span className="font-mono text-[10.5px]">.{r.name}</span> → {cls} <span className="text-muted-foreground">{r.kind}</span></li>)}
          {!out.length && !inc.length && <li className="text-muted-foreground">none</li>}
        </ul>
      </Section>
      <Section title="Operations anchored here" right={t('model.homeClass', 'home class')}>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">{anchored.length ? anchored.map((o) => <ModelLink key={o.id} target={`op:${o.id}`}>{o.name}</ModelLink>) : <span className="text-muted-foreground">none</span>}</div>
      </Section>
      <Section title="Read and written by" right={`${users.length} accesses`}>
        <table className="w-full table-fixed">
          <colgroup><col /><col className="w-[8.5rem]" /><col className="w-10" /><col className="w-16" />{ctx && <col className="w-[8.5rem]" />}</colgroup>
          <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="font-medium">operation</th><th className="pl-2 font-medium">mode</th><th className="text-right font-medium">stmt</th><th className="text-right font-medium">op rate</th>{ctx && <th className="pl-2 font-medium">in A</th>}</tr></thead>
          <tbody>
            {users.map(({ op, a }) => {
              const from = ctx?.opService(op);
              const site = sitesIn.find((s) => s.op === op.id && s.mode === a.mode);
              const across = svc && from && from.id !== svc.id;
              return (
                <tr key={`${op.id}|${a.mode}`} className="border-t border-border/50">
                  <td className="truncate py-0.5" title={op.id}><ModelLink target={`op:${op.id}`}>{op.name}</ModelLink> <span className="text-[10.5px] text-muted-foreground">{op.service}</span></td>
                  <td className="truncate pl-2">{a.mode}{a.mode === 'read' && <> <LevelChip c={{ level: levelOf(a), rules: a.rules, reason: a.reason }} texts={model.consistency} own={a.local} className="max-w-[5.5rem]" /></>}</td>
                  <td className="text-right tabular">{fmtN(a.count)}</td>
                  <td className="text-right tabular">{fmtRate(op.rate)}</td>
                  {ctx && <td className="truncate pl-2">{a.local ? <OwnData mode={a.mode} /> : <span className="inline-flex items-center gap-1" title={`from ${from?.name ?? '?'}`}><MechChip m={site ? ctx.siteMech(site.id) ?? 'sync' : 'sync'} active />{svc && from && <PlacementBadge together={!across} to={svc.name} where="A" />}</span>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      {(events.length > 0 || bindings.length > 0) && (
        <Section title="Events and bindings">
          <ul className="space-y-0.5">
            {events.map((e) => <li key={e.id}>carried by <code className="font-mono text-[10.5px]">{e.name}</code> <span className="text-muted-foreground">({e.publishers.join(', ') || 'no publisher reached'} → {e.reactions.join(', ')})</span></li>)}
            {bindings.map((b) => <li key={b.id}><Badge variant="outline" className="h-4 px-1 text-[9.5px]">{b.kind}</Badge> {b.classes.join(' + ')} <span className="text-muted-foreground">by {b.operations.length} operations</span></li>)}
          </ul>
        </Section>
      )}
    </div>
  );
}
