import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { Design, DesignDetail, DesignList, DesignSummary, Domain, Id, InputModel, Run, RunIndex, RunSummary } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import { BundleSource } from '../sources/bundle';
import type { Source, SourceConfig } from '../sources/source';
import { LocalConfig } from './local-config';
import { Packet } from './packets';
import { buildPluginVersion, type Simulator } from './simulator';

/**
 * sources.json: `packets[]`, the packet directories (a path, or {id, path}), and `sources[]`, further bundles
 * (kind `bundle`, `path`); EXPLORER_PACKETS (paths separated by the platform's delimiter) adds packet directories
 */
export interface SourcesFile {
  sources?: SourceConfig[];
  packets?: (string | { id?: string; path: string; enabled?: boolean })[];
}

const gzip = promisify(zlib.gzip);

export class Registry {
  sources: Source[] = [];
  private runSource = new Map<Id, Source>();
  /** serialised DesignList per run (plain and gzip), built on the first request */
  private listBodies = new Map<Id, Promise<{ json: string; gzip: Buffer } | null>>();
  private inflight = new Map<string, Promise<DesignDetail>>();

  private packetList: Packet[] = [];
  private packetById = new Map<Id, Packet>();
  private packetOfDomain = new Map<Id, Packet>();

  constructor(private root: string, private cacheDir: string, private simulator: Simulator, readonly local: LocalConfig = new LocalConfig(root)) {}

  async load() {
    // EXPLORER_SOURCES: another sources file (e.g. a second instance on other ports for a check), else sources.local.json, sources.json
    const local = path.join(this.root, 'sources.local.json');
    const file = process.env.EXPLORER_SOURCES ? path.resolve(process.env.EXPLORER_SOURCES) : fs.existsSync(local) ? local : path.join(this.root, 'sources.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as SourcesFile;
    // paths relative to core/explorer/
    const packetDirs: { id?: string; path: string }[] = [
      ...(cfg.packets ?? []).map((p) => (typeof p === 'string' ? { path: p } : p)).filter((p) => p.enabled !== false),
      ...(process.env.EXPLORER_PACKETS ?? '').split(path.delimiter).filter(Boolean).map((p) => ({ path: path.resolve(p) })),
    ];
    const configs: SourceConfig[] = [
      ...packetDirs.map((p): SourceConfig => ({ id: p.id ?? `packet:${path.basename(p.path)}`, kind: 'bundle', path: p.path })),
      ...(cfg.sources ?? []).filter((s) => s.enabled !== false),
    ];
    this.sources = configs.map((s) => {
      switch (s.kind) {
        case 'bundle': return new BundleSource(s, this.root, this.local);
        default: throw new Error(`unknown source kind ${s.kind}`);
      }
    });
    await Promise.all(this.sources.map((s) => s.load()));
    this.runSource.clear();
    this.listBodies.clear();
    for (const s of this.sources) for (const r of s.runs()) if (!this.runSource.has(r.id)) this.runSource.set(r.id, s);
    // the packets: a bundle's own, an implicit one (the defaults) for any other source with domains
    this.packetList = [];
    this.packetById.clear();
    this.packetOfDomain.clear();
    for (const s of this.sources) {
      const pk = s.packet?.() ?? (s.domains().length ? new Packet(s.status().location, null, { id: s.id, domains: s.domains().map((d) => d.id) }, this.local) : null);
      if (!pk || this.packetById.has(pk.id)) continue;
      pk.onRebuilt = () => { void this.load(); };
      this.packetList.push(pk);
      this.packetById.set(pk.id, pk);
      for (const d of [...pk.manifest.domains, ...s.domains().map((x) => x.id)]) if (!this.packetOfDomain.has(d)) this.packetOfDomain.set(d, pk);
    }
  }

  packets(): Packet[] { return this.packetList; }
  packet(id: Id): Packet | null { return this.packetById.get(id) ?? null; }
  /** the packet a domain (and so a run) belongs to */
  packetOf(domainId: Id): Packet | null { return this.packetOfDomain.get(domainId) ?? null; }

  index(): RunIndex {
    const prints = new Map<Id, Set<string>>();
    const domains = new Map<Id, Domain>();
    for (const s of this.sources) for (const d of s.domains()) domains.set(d.id, d);
    return {
      contract: CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      runs: this.sources.flatMap((s) => s.runs()).map((r) => this.modelTags(r, prints)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      domains: [...domains.values()].map((d) => ({ id: d.id, name: d.name, version: d.version })),
      sources: this.sources.map((s) => s.status()),
      packets: this.packetList.map((p) => p.summary()),
    };
  }

  domain(id: Id): Domain | null {
    for (const s of this.sources) for (const d of s.domains()) if (d.id === id) return d;
    return null;
  }

  /** the optimisation's input model of a domain */
  inputModel(domainId: Id): InputModel | null {
    for (const s of this.sources) { const m = s.inputModel?.(domainId); if (m) return m; }
    return null;
  }

  async run(id: Id): Promise<Run | null> {
    const r = (await this.runSource.get(id)?.run(id)) ?? null;
    return r && this.modelTags(r, new Map());
  }

  /**
   * a run's `earlier-model` tag from its seed's fingerprint: it was made with an earlier model when its seed is
   * none of the input model's seeds (a run without a fingerprint keeps its tags)
   */
  private modelTags<T extends RunSummary>(r0: T, prints: Map<Id, Set<string>>): T {
    const pk = this.packetOf(r0.domainId);
    const r = pk ? { ...r0, packet: pk.id } : r0;
    if (!r.modelFingerprint) return r;
    let p = prints.get(r.domainId);
    if (!p) prints.set(r.domainId, p = new Set(this.inputModel(r.domainId)?.inputs.map((i) => i.fingerprint).filter((x): x is string => !!x)));
    if (!p.size) return r;
    const tags = (r.tags ?? []).filter((t) => t !== 'earlier-model');
    return { ...r, tags: p.has(r.modelFingerprint) ? tags : [...tags, 'earlier-model'] };
  }

  async designs(runId: Id): Promise<DesignSummary[] | null> {
    return (await this.runSource.get(runId)?.designs(runId)) ?? null;
  }

  /** GET /api/runs/:id/designs as serialised JSON and its gzip form (a large run's list is 10+ MB) */
  designListBody(runId: Id): Promise<{ json: string; gzip: Buffer } | null> {
    let p = this.listBodies.get(runId);
    if (!p) {
      p = (async () => {
        const designs = await this.designs(runId);
        if (!designs) return null;
        const list: DesignList = { contract: CONTRACT_VERSION, runId, designs };
        const json = JSON.stringify(list);
        return { json, gzip: await gzip(json, { level: 6 }) };
      })();
      this.listBodies.set(runId, p);
      p.catch(() => this.listBodies.delete(runId));
    }
    return p;
  }

  async design(runId: Id, id: Id): Promise<Design | null> {
    return (await this.runSource.get(runId)?.design(runId, id)) ?? null;
  }

  /** precomputed, else cached, else (simulate=true) simulated now and cached */
  async detail(runId: Id, id: Id, simulate: boolean): Promise<{ detail: DesignDetail | null; status: 'precomputed' | 'cached' | 'simulated' | 'missing'; error?: string }> {
    const src = this.runSource.get(runId);
    const design = await this.design(runId, id);
    if (!src || !design) return { detail: null, status: 'missing', error: 'no such design' };
    const pre = await src.detail(runId, design.hash);
    if (pre) return { detail: pre, status: 'precomputed' };
    const run = (await this.run(runId))!;
    // a detail is cached per build (its seed, scripts and plugin), profile variant (run.problem: sim-day, sim-steady)
    // and plugin version: a build prepared again with another plugin simulates again
    const build = run.config.raw?.buildDir as string | undefined;
    const version = buildPluginVersion(run);
    const tag = (s: string) => s.replace(/[^A-Za-z0-9.+-]+/g, '_');
    const key = `${run.domainId}-${run.problem}-${design.hash}${build ? `-${tag(path.relative(path.resolve(this.cacheDir, '..'), build))}` : ''}${version ? `-${tag(version)}` : ''}`;
    const file = path.join(this.cacheDir, `${key}.json`);
    if (fs.existsSync(file)) return { detail: JSON.parse(fs.readFileSync(file, 'utf8')), status: 'cached' };
    if (!simulate) return { detail: null, status: 'missing' };
    const domain = this.domain(run.domainId);
    if (!domain || !design.decisions) return { detail: null, status: 'missing', error: 'the design has no decisions in the contract form (or its domain is unknown), so it cannot be simulated' };
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.simulator.simulate(domain, run, design, this.packetOf(run.domainId) ?? undefined).then((d) => {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(d));
        return d;
      }).finally(() => this.inflight.delete(key)));
    }
    try {
      return { detail: await this.inflight.get(key)!, status: 'simulated' };
    } catch (e) {
      return { detail: null, status: 'missing', error: (e as Error).message };
    }
  }
}
