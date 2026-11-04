/**
 * Data packets on the backend (contract/packet.ts, docs/packet-format.md): a packet is a bundle directory with a manifest
 * (packet.json). This module reads the manifest, its docs and Verify files, its named source trees (a git repository
 * at a commit, or a directory restricted to prefixes), its inputs' hashes (staleness) and runs its commands — only
 * the commands the LOCAL configuration allows (server/local-config.ts); a packet never enables its own.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Id } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import { defaultManifest, type PacketBody, type PacketCommand, type PacketManifest, type PacketSummary, type SourceTree } from '../contract/packet';
import type { LocalConfig } from './local-config';

export const MANIFEST = 'packet.json';

export interface SourceFile {
  tree: string;
  path: string;
  /** git trees: the commit read */
  commit?: string;
  text: string;
}

/** a file's sha256, cached by size and mtime */
const hashes = new Map<string, { key: string; hash: string | null }>();
export function hashFile(f: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(f); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashes.get(f);
  if (hit?.key === key) return hit.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  hashes.set(f, { key, hash });
  return hash;
}

/** a named source tree of a packet: its file list and files */
export class SourceTreeReader {
  private files: Set<string> | null = null;
  private cache = new Map<string, SourceFile>();
  constructor(readonly name: string, readonly def: SourceTree, readonly dir: string) {}

  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  }

  /** git: every file at the ref; dir: the files under the allowed prefixes */
  tree(): Set<string> {
    if (this.files) return this.files;
    if (this.def.kind === 'git') {
      try { this.files = new Set(this.git(['ls-tree', '-r', '--name-only', this.def.ref]).split('\n').filter(Boolean)); }
      catch { throw new Error(`${this.def.label} at ${this.dir} has no commit ${this.def.ref.slice(0, 12)}`); }
    } else {
      const out = new Set<string>();
      const root = fs.realpathSync(this.dir);
      // where a path really is: inside the tree, under an allowed prefix (a directory: on the way to one)
      const inside = (abs: string, dir = false) => {
        const r = fs.realpathSync(abs);
        if (r === root) return true;
        if (!r.startsWith(root + path.sep)) return false;
        const rel = path.relative(root, r).split(path.sep).join('/');
        return this.allowed(rel) || (dir && (this.def.kind !== 'dir' || !this.def.allow?.length || this.def.allow.some((a) => a.startsWith(`${rel}/`))));
      };
      const walk = (rel: string) => {
        const abs = path.join(this.dir, rel);
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { return; }
        if (st.isDirectory()) { if (!inside(abs, true)) return; for (const e of fs.readdirSync(abs)) if (!e.startsWith('.')) walk(rel ? `${rel}/${e}` : e); }
        else if (this.allowed(rel) && inside(abs)) out.add(rel);
      };
      for (const a of this.def.allow ?? ['']) walk(a.replace(/\/$/, ''));
      this.files = out;
    }
    return this.files;
  }

  private allowed(p: string): boolean {
    if (this.def.kind !== 'dir') return true;
    return !(this.def.allow?.length) || this.def.allow.some((x) => p.startsWith(x));
  }

  file(p: string): SourceFile {
    const hit = this.cache.get(p);
    if (hit) return hit;
    if (!p || p.includes('..') || path.isAbsolute(p)) throw new Error(`not a path of ${this.def.label}: ${p}`);
    let f: SourceFile;
    if (this.def.kind === 'git') {
      if (!this.tree().has(p)) throw new Error(`no file ${p} in ${this.def.label}@${this.def.ref.slice(0, 12)}`);
      f = { tree: this.name, path: p, commit: this.def.ref, text: this.git(['show', `${this.def.ref}:${p}`]) };
    } else {
      // the working tree as it is now (not cached: the Verify tab reads files the user edits)
      if (!this.allowed(p)) throw new Error(`not a file ${this.def.label} serves: ${p}`);
      // no way out of the tree through a symbolic link
      const real = fs.realpathSync(path.join(this.dir, p));
      const root = fs.realpathSync(this.dir);
      if (!real.startsWith(root + path.sep) || !this.allowed(path.relative(root, real).split(path.sep).join('/'))) throw new Error(`not a file ${this.def.label} serves: ${p}`);
      return { tree: this.name, path: p, text: fs.readFileSync(real, 'utf8') };
    }
    this.cache.set(p, f);
    return f;
  }
}

interface Job { state: 'updating' | 'failed'; error?: string; for: string }

export class Packet {
  readonly manifest: PacketManifest;
  readonly implicit: boolean;
  private trees = new Map<string, SourceTreeReader>();
  private docsCache: { key: string; docs: Record<string, unknown> } | null = null;
  private rebuildJob: Job | null = null;

  constructor(readonly dir: string, manifest: PacketManifest | null, fallback: { id: Id; domains: Id[] }, private local: LocalConfig) {
    this.implicit = !manifest;
    this.manifest = manifest ?? defaultManifest(fallback.id, fallback.domains, fs.existsSync(path.join(dir, 'models')), CONTRACT_VERSION);
  }

  /** packet.json of a directory, or null (a plain bundle); throws on a manifest of another major */
  static readManifest(dir: string): PacketManifest | null {
    const f = path.join(dir, MANIFEST);
    if (!fs.existsSync(f)) return null;
    const m = JSON.parse(fs.readFileSync(f, 'utf8')) as PacketManifest;
    if (String(m.contract ?? '').split('.')[0] !== CONTRACT_VERSION.split('.')[0]) throw new Error(`${f}: contract ${m.contract}, the explorer reads ${CONTRACT_VERSION.split('.')[0]}.x`);
    if (!m.id) throw new Error(`${f}: no id`);
    return m;
  }

  get id() { return this.manifest.id; }

  /** a named root (relative to the packet directory), or a path relative to the packet */
  root(name?: string): string {
    if (!name) return this.dir;
    const r = this.manifest.roots?.[name];
    return path.resolve(this.dir, r ?? name);
  }

  docs(): Record<string, unknown> {
    const entries = Object.entries(this.manifest.docs ?? {});
    const key = entries.map(([, f]) => { try { const st = fs.statSync(path.join(this.dir, f)); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } }).join('|');
    if (this.docsCache?.key === key) return this.docsCache.docs;
    const docs: Record<string, unknown> = {};
    for (const [name, f] of entries) {
      const file = path.join(this.dir, f);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      docs[name] = f.endsWith('.json') ? JSON.parse(text) : text;
    }
    this.docsCache = { key, docs };
    return docs;
  }

  /** the body of a Verify file (verify.parts | causes | chains), or null */
  verifyFile(name: 'parts' | 'causes' | 'chains'): string | null {
    if (!this.manifest.capabilities?.verify) return null;
    const f = this.manifest.verify?.[name];
    if (!f) return null;
    const file = path.join(this.dir, f);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  source(name: string): SourceTreeReader {
    let t = this.trees.get(name);
    const def = this.manifest.sources?.[name];
    if (!def) throw new Error(`the packet ${this.id} has no source tree ${name}`);
    if (!t) { t = new SourceTreeReader(name, def, path.resolve(this.root(def.root), def.path)); this.trees.set(name, t); }
    return t;
  }

  /** the commands the local configuration allows for this packet (and the packet declares) */
  allowedCommands(): string[] {
    return Object.keys(this.manifest.commands ?? {}).filter((c) => this.local.allows(this.id, c));
  }

  /** a command, if declared and allowed */
  command(name: string): PacketCommand | undefined {
    return this.local.allows(this.id, name) ? this.manifest.commands?.[name] : undefined;
  }

  /** argv and options of an allowed command with its placeholders filled (`{name}`; an array value expands to several args) */
  prepare(name: string, vars: Record<string, string | string[]> = {}): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number } {
    const c = this.command(name);
    vars = { packet: this.dir, ...vars };
    if (!c) throw new Error(this.manifest.commands?.[name] ? `the local configuration does not allow the packet ${this.id} to run ${name} (server.local.json allowCommands)` : `the packet ${this.id} has no command ${name}`);
    const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => { const v = vars[k] ?? (k in (this.manifest.roots ?? {}) ? this.root(k) : undefined); return v === undefined ? m : Array.isArray(v) ? v.join(' ') : v; });
    const argv = c.argv.flatMap((a) => { const m = /^\{(\w+)\}$/.exec(a); const v = m ? vars[m[1]] : undefined; return Array.isArray(v) ? v : [fill(a)]; });
    const cwd = c.cwd ? this.root(c.cwd) : this.dir;
    const env = { ...process.env, ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, fill(v)])) };
    const file = argv[0].includes('/') && !path.isAbsolute(argv[0]) ? path.resolve(cwd, argv[0]) : argv[0];
    return { file, args: argv.slice(1), cwd, env, timeoutMs: (c.timeoutS ?? 15 * 60) * 1000 };
  }

  /** run an allowed command to its end */
  run(name: string, vars: Record<string, string | string[]> = {}): Promise<{ stdout: string; stderr: string }> {
    const p = this.prepare(name, vars);
    return new Promise((resolve, reject) => {
      execFile(p.file, p.args, { cwd: p.cwd, env: p.env, maxBuffer: 1 << 26, timeout: p.timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${name} (${path.basename(p.file)}) failed: ${String(stderr).trim().split('\n').slice(-5).join(' | ') || err.message}`));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /** the recorded inputs whose content changed since the build */
  stale(): string[] {
    return (this.manifest.inputs ?? []).filter((i) => !hashFile(path.resolve(this.root(i.root), i.path))?.startsWith(i.hash)).map((i) => i.path);
  }

  /**
   * the packet against its inputs: `current`, or stale — rebuilt in the background when the local configuration
   * allows `rebuild` (one rebuild at a time; `updating` until it ends, `failed` with its error), else `stale`
   */
  freshness(vars: Record<string, string | string[]> = {}, extra: string[] = []): { state: 'current' | 'updating' | 'failed' | 'stale'; changed: string[]; error?: string } {
    const changed = [...new Set([...this.stale(), ...extra])];
    const now = `${this.manifest.builtAt}|${changed.join(',')}`;
    if (this.rebuildJob && this.rebuildJob.for !== now && this.rebuildJob.state === 'failed') this.rebuildJob = null;
    if (!changed.length) {
      if (this.rebuildJob?.state === 'updating') return { state: 'updating', changed };
      this.rebuildJob = null;
      return { state: 'current', changed };
    }
    if (!this.rebuildJob) {
      if (!this.command('rebuild')) return { state: 'stale', changed };
      this.rebuildJob = this.startRebuild(now, vars);
    }
    return { state: this.rebuildJob.state, changed, ...(this.rebuildJob.error ? { error: this.rebuildJob.error } : {}) };
  }

  private startRebuild(now: string, vars: Record<string, string | string[]>): Job {
    const job: Job = { state: 'updating', for: now };
    let p;
    try { p = this.prepare('rebuild', vars); } catch (e) { return { ...job, state: 'failed', error: (e as Error).message }; }
    const child = spawn(p.file, p.args, { cwd: p.cwd, env: p.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { job.state = 'failed'; job.error = e.message; });
    child.on('exit', (code) => {
      if (code === 0) { if (this.rebuildJob === job) this.rebuildJob = null; this.onRebuilt?.(); return; }
      job.state = 'failed';
      job.error = `rebuild exited with ${code}: ${err.trim().split('\n').slice(-6).join('\n')}`;
    });
    return job;
  }

  /** called after a rebuild ended well (the registry re-reads the packet) */
  onRebuilt?: () => void;

  summary(): PacketSummary {
    const m = this.manifest;
    const stale = this.implicit ? [] : this.stale();
    return {
      id: m.id, name: m.name, description: m.description, family: m.family, domains: m.domains,
      capabilities: m.capabilities ?? {}, fingerprint: m.fingerprint, allowedCommands: this.allowedCommands(),
      ...(stale.length ? { stale } : {}), ...(this.implicit ? { implicit: true } : {}),
    };
  }

  body(): PacketBody {
    return { contract: CONTRACT_VERSION, manifest: this.manifest, docs: this.docs(), summary: this.summary() };
  }
}
