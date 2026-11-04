import { useMemo } from 'react';
import type { Domain, InputModel } from '@contract/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { patchUrl } from '@/lib/useWorkspace';
import { workspaceActions } from '@/lib/useWorkspace';
import type { ModelTarget } from '@/lib/modelTarget';
import { ClassDiagram, type UmlEdge, type UmlGroup, type UmlNode } from './ClassDiagram';
import { ClassDetail, OperationDetail } from './details';
import { Section, fmtN, type DesignContext } from './shared';
import { useT } from './text';

/** the domain model (layer 1): the classes and their references as a class diagram, a class's or an operation's detail beside it */
export function DomainTab({ model, domain, target, ctx, group, attrs, narrow, focusKey }: {
  model: InputModel; domain?: Domain; target: ModelTarget | null; ctx: DesignContext | null; group: string; attrs: boolean; narrow: boolean; focusKey: number;
}) {
  const op = target?.kind === 'op' ? model.operations.find((o) => o.id === target.id) : undefined;
  const cls = target?.kind === 'class' ? target.id : undefined;
  const anchored = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of model.operations) m.set(o.homeClass, (m.get(o.homeClass) ?? 0) + 1);
    return m;
  }, [model]);
  const aggOf = useMemo(() => new Map((domain?.classes ?? []).map((c) => [c.id, c.aggregate])), [domain]);
  const { nodes, edges, groups } = useMemo(() => {
    const groups: UmlGroup[] = group === 'service' ? [...new Set(model.classes.map((c) => c.service))].map((s) => ({ id: s, label: `${s} (today)` }))
      : group === 'aggregate' ? (domain?.aggregates ?? []).filter((a) => a.classes.length > 1).map((a) => ({ id: a.id, label: `${a.name} aggregate` })) : [];
    const gid = new Set(groups.map((g) => g.id));
    const nodes: UmlNode[] = model.classes.map((c) => {
      const g = group === 'service' ? c.service : group === 'aggregate' ? aggOf.get(c.id) : undefined;
      return {
        id: c.id, title: c.id, group: g && gid.has(g) ? g : undefined, badge: anchored.get(c.id) ? `${anchored.get(c.id)} ops` : undefined,
        rows: attrs ? c.attributes.map((a) => ({ text: a, kind: 'attr' as const })) : [],
        tooltip: `${c.id} — today in ${c.service}; ${anchored.get(c.id) ?? 0} operations anchored here; ${c.table ?? c.storage}`,
      };
    });
    const edges: UmlEdge[] = model.references.map((r) => (r.kind === 'composition'
      ? { id: `ref:${r.id}`, source: r.to, target: r.from, kind: 'containment' as const, label: `${r.name}${r.snapshot ? ' (snapshot)' : ''}`, tooltip: `${r.to} ◆ ${r.from} (composition; ${r.from}.${r.name})` }
      : { id: `ref:${r.id}`, source: r.from, target: r.to, kind: 'ref' as const, label: `${r.name} ${r.upper < 0 ? '[*]' : '[1]'}${r.snapshot ? ' snapshot' : ''}`, tooltip: `${r.from}.${r.name} → ${r.to} (${r.kind}${r.storage ? `, ${r.storage}` : ''})` }));
    return { nodes, edges, groups };
  }, [model, group, attrs, aggOf, anchored, domain]);
  const highlight = useMemo(() => (op ? new Set([op.homeClass, ...op.accesses.map((a) => a.class)]) : null), [op]);
  const select = (id: string | null) => workspaceActions.openModel(id ? `class:${id}` : 'domain');
  const t = useT();
  const nServices = new Set(model.classes.map((c) => c.service)).size;
  const txWorkflows = model.processes.filter((p) => p.transaction && (!p.transaction.home || p.transaction.home.written)).length;

  const detail = op ? <OperationDetail model={model} op={op} ctx={ctx} compact /> : cls ? <ClassDetail model={model} cls={cls} ctx={ctx} /> : (
    <div className="space-y-3 p-3 text-xs">
      <Section title="The domain model (layer 1)">
        <p>{t('model.domain.about', 'The persisted classes of the domain: {{classes}} classes, {{references}} references (compositions bind a part to its whole).', { classes: model.classes.length, references: model.references.length })}</p>
        <p className="text-muted-foreground">{t('model.domain.cut', "The cut decides which service every class lives in: a class's component (its operations) and its schema are placed by the optimisation. Operations are anchored at their home class; the badge counts them.")}</p>
      </Section>
      <Section title="Reading the diagram">
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          <li>Boxes: classes with their columns; grouped by today's service, by aggregate (composition closure) or not at all.</li>
          <li>A diamond: the whole of a composition (the part's id column refers to it); an open arrow: an association.</li>
          <li>Click a class for its references, operations and accesses; an operation in the Operations tab lights up the classes it touches.</li>
        </ul>
      </Section>
      <Section title="Sizes"><p className="tabular text-muted-foreground">{model.classes.length} classes · {model.operations.length} operations ({model.operations.reduce((s, o) => s + o.accesses.length, 0)} accesses) · {model.events.length} domain events · {model.bindings.length} bindings · {model.processes.filter((p) => !p.transaction).length} processes{txWorkflows ? t('model.domain.txWorkflows', ' (+ {{n}} transaction workflows)', { n: txWorkflows }) : ''} · total {fmtN(model.operations.reduce((s, o) => s + o.rate, 0), 0)} operation executions/s</p></Section>
    </div>
  );

  return (
    <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
      <ResizablePanel defaultSize={narrow ? '58%' : '62%'} minSize="30%">
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
            <ToggleGroup type="single" size="sm" variant="outline" value={group} onValueChange={(v) => v && patchUrl({ mgroup: v === 'service' ? null : v })} aria-label="Group classes">
              <ToggleGroupItem value="service" className="h-7 px-2 text-xs" title={`grouped by today's ${nServices} services`}>today's services</ToggleGroupItem>
              <ToggleGroupItem value="aggregate" className="h-7 px-2 text-xs" title="grouped by aggregate (composition closure)">aggregates</ToggleGroupItem>
              <ToggleGroupItem value="none" className="h-7 px-2 text-xs">no groups</ToggleGroupItem>
            </ToggleGroup>
            <Label className="flex items-center gap-1.5 text-xs font-normal"><Switch checked={attrs} onCheckedChange={(v) => patchUrl({ mattr: v ? '1' : null })} /> columns</Label>
            {op && <span className="ml-auto truncate text-xs text-muted-foreground">touched by <b className="text-foreground">{op.name}</b> ({highlight!.size} classes)</span>}
          </div>
          <div className="min-h-0 flex-1">
            <ClassDiagram name={`domain-${group}-${attrs ? 'a' : 'n'}`} nodes={nodes} edges={edges} groups={groups} selected={cls ?? null} highlight={highlight} onSelect={select} direction="DOWN" focusKey={cls ? focusKey : undefined} />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={narrow ? '42%' : '38%'} minSize="22%">
        <ScrollArea className="h-full">{detail}</ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
