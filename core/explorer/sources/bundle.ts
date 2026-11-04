/**
 * Explorer bundle: the contract's on-disk format (CONTRACT.md), written by the exporters and the
 * synthetic generator:  domains/<id>.json, runs/<run>/run.json, runs/<run>/designs.jsonl (preferred) or
 * runs/<run>/designs.json, runs/<run>/details/<hash>.json, models/<domainId>.json (the input model),
 * packet.json (a data packet's manifest, server/packets.ts; without one the bundle is a packet with the defaults)
 *
 * designs.jsonl is streamed once: only the summaries and a byte range per design are kept, a
 * design's decisions are read from the file on demand. designs.json is loaded whole.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Design, DesignDetail, DesignSummary, Domain, Id, InputModel, Run, RunSummary, SourceStatus } from '../contract/types';
import { indexDesignsJsonl, readJsonlAt, toSummary, type DesignIndexEntry } from '../contract/jsonl';
import { summarize, type Source, type SourceConfig } from './source';
import { LocalConfig } from '../server/local-config';
import { Packet } from '../server/packets';

const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8')) as T;

type RunDesigns =
  | { kind: 'jsonl'; file: string; summaries: DesignSummary[]; at: Map<Id, DesignIndexEntry> }
  | { kind: 'json'; summaries: DesignSummary[]; byId: Map<Id, Design> };

export class BundleSource implements Source {
  readonly kind = 'bundle' as const;
  readonly id: Id;
  private root: string;
  private hint: string | undefined;
  private summaries: RunSummary[] = [];
  private doms: Domain[] = [];
  private designCache = new Map<Id, Promise<RunDesigns | null>>();
  private st: SourceStatus;
  private pk: Packet | null = null;

  constructor(cfg: SourceConfig, base: string, private local: LocalConfig = LocalConfig.of(false)) {
    this.id = cfg.id;
    this.root = path.resolve(base, String(cfg.path));
    this.hint = cfg.hint !== undefined ? String(cfg.hint) : undefined;
    this.st = { id: this.id, kind: 'bundle', location: this.root, ok: false, runs: 0, mode: 'files' };
  }

  async load() {
    this.designCache.clear();
    this.doms = [];
    this.summaries = [];
    this.pk = null;
    if (!fs.existsSync(this.root)) {
      this.st = { ...this.st, ok: true, runs: 0, message: this.hint ? `not generated (${this.hint})` : 'nothing exported yet' };
      return;
    }
    try {
      const ddir = path.join(this.root, 'domains');
      this.doms = fs.existsSync(ddir) ? fs.readdirSync(ddir).filter((f) => f.endsWith('.json')).map((f) => readJson<Domain>(path.join(ddir, f))) : [];
      const rdir = path.join(this.root, 'runs');
      this.summaries = fs.existsSync(rdir)
        ? fs.readdirSync(rdir).filter((r) => fs.existsSync(path.join(rdir, r, 'run.json'))).map((r) => summarize(readJson<Run>(path.join(rdir, r, 'run.json'))))
        : [];
      this.pk = new Packet(this.root, Packet.readManifest(this.root), { id: this.id, domains: this.doms.map((d) => d.id) }, this.local);
      this.st = { ...this.st, ok: true, runs: this.summaries.length, message: this.summaries.length ? undefined : `no runs${this.hint ? ` (${this.hint})` : ''}` };
    } catch (e) {
      // a bundle that cannot be read (or a packet of another contract major) serves nothing
      this.doms = [];
      this.summaries = [];
      this.pk = null;
      this.st = { ...this.st, ok: false, runs: 0, message: String(e) };
    }
  }

  status() { return this.st; }
  /** the bundle's packet (its packet.json, else the defaults); null while the directory does not exist */
  packet() { return this.pk; }
  runs() { return this.summaries; }
  domains() { return this.doms; }

  async run(id: Id) {
    const f = path.join(this.root, 'runs', id, 'run.json');
    return fs.existsSync(f) ? readJson<Run>(f) : null;
  }

  private runDesigns(runId: Id): Promise<RunDesigns | null> {
    let p = this.designCache.get(runId);
    if (!p) {
      p = this.readDesigns(runId);
      this.designCache.set(runId, p);
      p.catch(() => this.designCache.delete(runId));
    }
    return p;
  }

  private async readDesigns(runId: Id): Promise<RunDesigns | null> {
    const dir = path.join(this.root, 'runs', runId);
    const jsonl = path.join(dir, 'designs.jsonl');
    if (fs.existsSync(jsonl)) {
      const { summaries, at } = await indexDesignsJsonl(jsonl);
      return { kind: 'jsonl', file: jsonl, summaries, at };
    }
    const json = path.join(dir, 'designs.json');
    if (!fs.existsSync(json)) return null;
    const list = readJson<{ designs: Design[] }>(json).designs;
    return { kind: 'json', summaries: list.map(toSummary), byId: new Map(list.map((d) => [d.id, d])) };
  }

  async designs(runId: Id) {
    return (await this.runDesigns(runId))?.summaries ?? null;
  }

  async design(runId: Id, id: Id): Promise<Design | null> {
    const rd = await this.runDesigns(runId);
    if (!rd) return null;
    if (rd.kind === 'json') return rd.byId.get(id) ?? null;
    const e = rd.at.get(id);
    return e ? readJsonlAt<Design>(rd.file, e.offset, e.length) : null;
  }

  /** models/<domainId>.json, read on each request (an export may replace it; POST /api/reload is not needed) */
  inputModel(domainId: Id): InputModel | null {
    const f = path.join(this.root, 'models', `${path.basename(domainId)}.json`);
    return fs.existsSync(f) ? readJson<InputModel>(f) : null;
  }

  async detail(runId: Id, hash: string) {
    const f = path.join(this.root, 'runs', runId, 'details', `${hash}.json`);
    return fs.existsSync(f) ? readJson<DesignDetail>(f) : null;
  }
}
