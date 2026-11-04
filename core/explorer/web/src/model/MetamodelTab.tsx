import { useMemo } from 'react';
import type { InputModel, Metamodel, MmClass, MmReference } from '@contract/types';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { patchUrl, workspaceActions } from '@/lib/useWorkspace';
import { RichText } from '@/help/RichText';
import { ClassDiagram, type UmlEdge, type UmlNode, type UmlRow } from './ClassDiagram';
import { ModelLink, RepoPath, Section } from './shared';

const ALL = '*';
/** the part of a metamodel shown first: PCM by its views, the layers without their traces (sections named "... trace") */
const DEFAULT_PART: Record<string, string> = { domain: ALL, architecture: 'overview', palladio: 'Behaviour' };
const isTrace = (s?: string) => !!s && /trace/i.test(s);
const mult = (m: string) => (m === '1' ? '' : `[${m}]`);

interface Index { owner: Map<string, string>; classes: Map<string, MmClass>; subs: Map<string, string[]> }

function useIndex(model: InputModel): Index {
  return useMemo(() => {
    const owner = new Map<string, string>(), classes = new Map<string, MmClass>(), subs = new Map<string, string[]>();
    for (const mm of model.metamodels) for (const c of mm.classes) { owner.set(c.name, mm.id); classes.set(c.name, c); }
    for (const mm of model.metamodels) for (const e of mm.enums) owner.set(e.name, mm.id);
    for (const c of classes.values()) for (const s of c.supers) subs.set(s, [...(subs.get(s) ?? []), c.name]);
    return { owner, classes, subs };
  }, [model]);
}

/** parts of a metamodel to show: its views (PCM) or sections (the layers) */
function partsOf(mm: Metamodel): { id: string; label: string }[] {
  if (mm.views.length > 1) return [...mm.views.map((v) => ({ id: v.name, label: v.name })), { id: ALL, label: 'everything' }];
  const secs = mm.sections.filter((s) => mm.classes.some((c) => c.section === s));
  const out = [{ id: ALL, label: 'everything' }];
  if (secs.some(isTrace) && secs.length > 2) out.unshift({ id: 'overview', label: 'everything but the traces' });
  return [...out, ...secs.map((s) => ({ id: s, label: s }))];
}

function classesOf(mm: Metamodel, part: string, usedOnly: boolean): Set<string> {
  let names: string[];
  const view = mm.views.find((v) => v.name === part);
  if (view) names = view.classes;
  else if (part === ALL) names = [...mm.classes.map((c) => c.name), ...mm.enums.map((e) => e.name)];
  else if (part === 'overview') names = [...mm.classes.filter((c) => !isTrace(c.section)).map((c) => c.name), ...mm.enums.map((e) => e.name)];
  else names = [...mm.classes.filter((c) => c.section === part).map((c) => c.name), ...mm.enums.filter((e) => e.section === part).map((e) => e.name)];
  const cls = new Map(mm.classes.map((c) => [c.name, c]));
  return new Set(names.filter((n) => !usedOnly || !cls.has(n) || (cls.get(n)!.used ?? 0) > 0));
}

/** a layer's root: the class that contains most of the others (Domain, ArchitectureDecisions, ...): its containments are folded into rows */
function roots(mm: Metamodel): Set<string> {
  const n = new Map<string, number>();
  for (const r of mm.references) if (r.kind === 'containment') n.set(r.source, (n.get(r.source) ?? 0) + 1);
  return new Set([...n.entries()].filter(([, k]) => k >= 5).map(([c]) => c));
}

function buildDiagram(mm: Metamodel, shown: Set<string>, ix: Index) {
  const rootSet = roots(mm);
  const refsOf = new Map<string, MmReference[]>();
  for (const r of mm.references) refsOf.set(r.source, [...(refsOf.get(r.source) ?? []), r]);
  const layerOf = (t: string) => (ix.owner.get(t) && ix.owner.get(t) !== mm.id ? ` (${ix.owner.get(t)})` : '');
  const nodes: UmlNode[] = [];
  const edges: UmlEdge[] = [];
  for (const e of mm.enums) if (shown.has(e.name)) nodes.push({ id: e.name, title: e.name, stereotype: '«enum»', rows: e.literals.map((l) => ({ text: l, kind: 'lit' as const })), tooltip: e.doc });
  for (const c of mm.classes) {
    if (!shown.has(c.name)) continue;
    const rows: UmlRow[] = [];
    const outside = c.supers.filter((s) => !shown.has(s));
    if (outside.length) rows.push({ text: `extends ${outside.join(', ')}`, kind: 'note', title: outside.map((s) => `${s}${layerOf(s)}`).join(', ') });
    for (const a of c.attributes) rows.push({ text: `${a.name}: ${a.type}${mult(a.multiplicity)}`, kind: 'attr', title: a.doc });
    for (const r of refsOf.get(c.name) ?? []) {
      const fold = rootSet.has(c.name) && r.kind === 'containment';
      if (shown.has(r.target) && !fold) continue;
      rows.push({ text: `${r.kind === 'containment' ? '◆ ' : '→ '}${r.name}: ${r.target}${mult(r.multiplicity) || '[1]'}`, kind: 'ref', title: `${r.name} → ${r.target}${layerOf(r.target)}${r.doc ? `: ${r.doc}` : ''}` });
    }
    nodes.push({
      id: c.name, title: c.name, stereotype: c.abstract ? '«abstract»' : undefined, rows, tone: rootSet.has(c.name) ? 'root' : 'normal',
      badge: c.used ? `${c.used}` : undefined, tooltip: `${c.name}${c.doc ? `: ${c.doc}` : ''}${c.used !== undefined ? ` — ${c.used} instances in today's realised model` : ''}`,
    });
    for (const s of c.supers) if (shown.has(s)) edges.push({ id: `inh:${c.name}>${s}`, source: c.name, target: s, kind: 'inherit', tooltip: `${c.name} extends ${s}` });
    for (const r of refsOf.get(c.name) ?? []) {
      if (!shown.has(r.target) || (rootSet.has(c.name) && r.kind === 'containment')) continue;
      edges.push({ id: `ref:${c.name}.${r.name}`, source: c.name, target: r.target, kind: r.kind === 'containment' ? 'containment' : r.kind === 'bidirectional' ? 'bidir' : 'ref',
        label: `${r.name}${mult(r.multiplicity) || ''}${r.opposite ? ` / ${r.opposite}` : ''}`, tooltip: `${c.name}.${r.name}${mult(r.multiplicity)} → ${r.target}${r.doc ? `: ${r.doc}` : ''}` });
    }
  }
  // attributes typed by a shown enum: an edge to the enum
  for (const c of mm.classes) if (shown.has(c.name)) for (const a of c.attributes) if (shown.has(a.type) && mm.enums.some((e) => e.name === a.type)) {
    edges.push({ id: `enum:${c.name}.${a.name}`, source: c.name, target: a.type, kind: 'ref', label: a.name, tooltip: `${c.name}.${a.name}: ${a.type}` });
  }
  return { nodes, edges };
}

function ClassInfo({ mm, name, ix, model }: { mm: Metamodel; name: string; ix: Index; model: InputModel }) {
  const c = mm.classes.find((x) => x.name === name);
  const en = mm.enums.find((x) => x.name === name);
  if (en) return (
    <div className="space-y-2 p-3 text-xs"><h2 className="text-sm font-semibold">{en.name} <span className="font-normal text-muted-foreground">enum</span></h2>{en.doc && <p><RichText text={en.doc} /></p>}<div className="flex flex-wrap gap-1">{en.literals.map((l) => <code key={l} className="rounded bg-muted px-1 font-mono text-[10.5px]">{l}</code>)}</div></div>
  );
  if (!c) return <p className="p-3 text-xs text-muted-foreground">No class {name} in {mm.title}.</p>;
  const link = (t: string) => <ModelLink target={`mm:${ix.owner.get(t) ?? mm.id}/${t}`}>{t}</ModelLink>;
  const out = mm.references.filter((r) => r.source === name);
  const inc = model.metamodels.flatMap((m) => m.references.filter((r) => r.target === name).map((r) => ({ r, m })));
  const subs = ix.subs.get(name) ?? [];
  return (
    <div className="space-y-3 p-3 text-xs">
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className={c.abstract ? 'text-sm font-semibold italic' : 'text-sm font-semibold'}>{c.name}</h2>
          <span className="text-muted-foreground">{c.abstract ? 'abstract class' : 'class'} of {mm.title} ({mm.layer}){c.section ? ` · ${c.section}` : ''}</span>
        </div>
        {c.supers.length > 0 && <p className="text-muted-foreground">extends {c.supers.map((s, i) => <span key={s}>{i ? ', ' : ''}{link(s)}</span>)}</p>}
        {c.doc && <p className="mt-1"><RichText text={c.doc} /></p>}
        <p className="mt-1 text-muted-foreground">{c.used ?? 0} instances (with subclasses) in today's realised seed model.</p>
      </div>
      {c.attributes.length > 0 && (
        <Section title="Attributes">
          <dl className="space-y-1">{c.attributes.map((a) => <div key={a.name}><dt className="font-mono text-[10.5px]">{a.name}: {a.type}{mult(a.multiplicity)}</dt>{a.doc && <dd className="text-muted-foreground"><RichText text={a.doc} /></dd>}</div>)}</dl>
        </Section>
      )}
      {out.length > 0 && (
        <Section title="References">
          <dl className="space-y-1">{out.map((r) => <div key={r.name}><dt><span className="font-mono text-[10.5px]">{r.kind === 'containment' ? '◆ ' : ''}{r.name}{mult(r.multiplicity) || '[1]'}</span> → {link(r.target)}{r.opposite && <span className="text-muted-foreground"> (opposite {r.opposite})</span>}</dt>{r.doc && <dd className="text-muted-foreground"><RichText text={r.doc} /></dd>}</div>)}</dl>
        </Section>
      )}
      {inc.length > 0 && (
        <Section title="Referenced by">
          <ul className="space-y-0.5">{inc.map(({ r, m }) => <li key={`${m.id}.${r.source}.${r.name}`}>{link(r.source)}<span className="font-mono text-[10.5px]">.{r.name}</span> <span className="text-muted-foreground">({m.title}{r.kind === 'containment' ? ', contains' : ''})</span></li>)}</ul>
        </Section>
      )}
      {subs.length > 0 && <Section title="Subclasses"><div className="flex flex-wrap gap-x-2">{subs.map((s) => <span key={s}>{link(s)}</span>)}</div></Section>}
    </div>
  );
}

/** the metamodels: layer 1 (domain), 2 (architecture decisions), 3 (microservice mechanisms), PCM, parsed from the .mm files */
export function MetamodelTab({ model, mmId, cls, part: partParam, usedParam, narrow, focusKey }: {
  model: InputModel; mmId: string; cls?: string; part: string | null; usedParam: string | null; narrow: boolean; focusKey: number;
}) {
  const ix = useIndex(model);
  const mm = model.metamodels.find((m) => m.id === mmId) ?? model.metamodels[0];
  const parts = partsOf(mm);
  // a class opened by a link shows in its part
  const partOfCls = cls ? (mm.views.length > 1 ? mm.views.find((v) => v.classes.includes(cls))?.name : undefined) : undefined;
  const part = partParam && parts.some((p) => p.id === partParam) ? partParam : partOfCls ?? DEFAULT_PART[mm.id] ?? ALL;
  const usedOnly = usedParam === null ? mm.id === 'palladio' : usedParam === '1';
  const shown = useMemo(() => { const s = classesOf(mm, part, usedOnly); if (cls && mm.classes.some((c) => c.name === cls)) s.add(cls); return s; }, [mm, part, usedOnly, cls]);
  const { nodes, edges } = useMemo(() => buildDiagram(mm, shown, ix), [mm, shown, ix]);
  const para = mm.description.split(/\n\s*\n/)[0].replace(/\n/g, ' ');
  return (
    <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
      <ResizablePanel defaultSize={narrow ? '60%' : '64%'} minSize="30%">
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
            <ToggleGroup type="single" size="sm" variant="outline" value={mm.id} onValueChange={(v) => v && workspaceActions.openModel(`mm:${v}`)} aria-label="Metamodel">
              {model.metamodels.map((m) => <ToggleGroupItem key={m.id} value={m.id} className="h-7 px-2 text-xs" title={`${m.title} (${m.layer})`}>{m.layer === 'PCM' ? 'PCM' : `${m.layer.replace('layer ', 'L')} ${m.id}`}</ToggleGroupItem>)}
            </ToggleGroup>
            <Select value={part} onValueChange={(v) => patchUrl({ mview: v === DEFAULT_PART[mm.id] ? null : v })}>
              <SelectTrigger size="sm" className="h-7 w-[220px] text-xs" aria-label="Part of the metamodel"><SelectValue /></SelectTrigger>
              <SelectContent>{parts.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
            <Label className="flex items-center gap-1.5 text-xs font-normal" title="only classes with instances in today's realised model"><Switch checked={usedOnly} onCheckedChange={(v) => patchUrl({ mused: v === (mm.id === 'palladio') ? null : v ? '1' : '0' })} /> used only</Label>
            <span className="ml-auto text-[11px] text-muted-foreground">{shown.size} of {mm.classes.length + mm.enums.length}</span>
          </div>
          <div className="min-h-0 flex-1">
            <ClassDiagram name={`mm-${mm.id}-${part}-${usedOnly ? 'u' : 'a'}${cls && !classesOf(mm, part, usedOnly).has(cls) ? `-${cls}` : ''}`} nodes={nodes} edges={edges} selected={cls ?? null}
              onSelect={(id) => workspaceActions.openModel(id ? `mm:${mm.id}/${id}` : `mm:${mm.id}`)} direction="DOWN" focusKey={cls ? focusKey : undefined} />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={narrow ? '40%' : '36%'} minSize="22%">
        <ScrollArea className="h-full">
          {cls ? <ClassInfo mm={mm} name={cls} ix={ix} model={model} /> : (
            <div className="space-y-3 p-3 text-xs">
              <div className="flex flex-wrap items-baseline gap-2"><h2 className="text-sm font-semibold">{mm.title}</h2><span className="text-muted-foreground">{mm.layer}</span></div>
              <p><RichText text={para} /></p>
              <div className="flex flex-wrap gap-1">{mm.files.map((f) => <RepoPath key={f} path={f} />)}</div>
              <Section title="Contents"><p className="text-muted-foreground">{mm.classes.length} classes, {mm.enums.length} enums, {mm.references.length} references{mm.imports.length ? `; imports ${mm.imports.join(', ')}` : ''}. Rows: attributes (type, multiplicity), ◆ contained and → referenced classes outside the part shown; a layer's root lists its containments as rows. The badge counts instances in today's realised seed.</p></Section>
              <details className="rounded-md border p-2"><summary className="cursor-pointer text-muted-foreground">the file's header</summary><p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">{mm.description}</p></details>
            </div>
          )}
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
