/**
 * The generic explorer over the tiny fixture packet (tests/fixtures/packet-tiny, a made-up bookshop): the backend
 * serves it in-process (server/app.ts) from a Registry over a temporary sources file; commands, the local
 * configuration, staleness and source trees on temporary copies. Needs nothing of build/ or the case.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DesignDetail, DesignList, Design, Run, RunIndex } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import type { PacketBody, PacketManifest } from '../contract/packet';
import { designHash } from '../contract/hash';
import { createApp } from '../server/app';
import { LocalConfig } from '../server/local-config';
import { Packet, SourceTreeReader } from '../server/packets';
import { Registry } from '../server/registry';
import { DummySimulator, type Simulator } from '../server/simulator';

const FIXTURE = path.resolve(__dirname, 'fixtures/packet-tiny');
const ID = 'bookshop';
const RUN = 'bookshop-static';
// the registry reads these; the test gives its own sources file
delete process.env.EXPLORER_SOURCES;
delete process.env.EXPLORER_PACKETS;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-packet-fixture-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** a registry over a temporary sources file listing the given packet directories */
async function registryOf(packets: string[], local = LocalConfig.of(false), simulator: Simulator = new DummySimulator()) {
  const root = path.join(tmp, `root-${n++}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ packets: packets.map((p) => ({ path: p })), sources: [] }));
  const reg = new Registry(root, path.join(root, 'cache'), simulator, local);
  await reg.load();
  return reg;
}

/** a copy of the fixture with its manifest changed */
function copyFixture(change: (m: PacketManifest) => void = () => {}): string {
  const dir = path.join(tmp, `packet-${n++}`);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const f = path.join(dir, 'packet.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8')) as PacketManifest;
  change(m);
  fs.writeFileSync(f, JSON.stringify(m));
  return dir;
}

const sha16 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

describe('the fixture packet over the API', async () => {
  const reg = await registryOf([FIXTURE]);
  const app = createApp(reg);
  const get = async <T>(url: string, status = 200): Promise<T> => {
    const r = await app.request(url);
    expect(r.status, url).toBe(status);
    return (await r.json()) as T;
  };

  it('/api/index lists the packet and every run belongs to it', async () => {
    const idx = await get<RunIndex>('/api/index');
    expect(idx.packets?.map((p) => p.id)).toEqual([ID]);
    const p = idx.packets![0];
    expect(p).toMatchObject({ name: 'Bookshop', domains: [ID], allowedCommands: [], capabilities: { model: false, verify: false, performance: true, simulate: false } });
    expect(p.family).toBeUndefined();
    expect(p.stale).toBeUndefined();
    expect(p.implicit).toBeUndefined();
    expect(idx.runs.map((r) => r.id)).toEqual([RUN]);
    expect(idx.runs.every((r) => r.packet === ID)).toBe(true);
    expect(idx.domains.map((d) => d.id)).toEqual([ID]);
    expect(idx.sources.every((s) => s.ok)).toBe(true);
  });

  it('/api/packets/<id>: the manifest with its docs inlined', async () => {
    const list = await get<{ id: string }[]>('/api/packets');
    expect(list.map((p) => p.id)).toEqual([ID]);
    const body = await get<PacketBody>(`/api/packets/${ID}`);
    expect(body.contract).toBe(CONTRACT_VERSION);
    expect(body.manifest.id).toBe(ID);
    expect(Object.keys(body.docs).sort()).toEqual(['metrics', 'texts']);
    expect((body.docs.texts as Record<string, string>)['fixture.title']).toBe('The **bookshop**');
    expect((body.docs.metrics as { key: string }[]).map((d) => d.key)).toEqual(['cost', 'failure', 'inconsistency', 'latencyBudget']);
    expect(body.summary.allowedCommands).toEqual([]);
    await get(`/api/packets/nope`, 404);
  });

  it('runs, designs, a design and the precomputed detail', async () => {
    const run = await get<Run>(`/api/runs/${RUN}`);
    expect(run.packet).toBe(ID);
    expect(run.objectives.map((o) => o.key)).toEqual(['cost', 'failure', 'inconsistency']);
    expect(run.constraints.map((c) => c.key)).toEqual(['latencyBudget']);
    const list = await get<DesignList>(`/api/runs/${RUN}/designs`);
    expect(list.designs.length).toBeGreaterThanOrEqual(5);
    expect(list.designs.some((d) => 'decisions' in d)).toBe(false);
    expect(list.designs.filter((d) => d.reference).map((d) => d.label).sort()).toEqual(['monolith', 'three services']);
    const withDetail = list.designs.find((d) => d.hasDetail)!;
    const d = await get<Design>(`/api/runs/${RUN}/designs/${withDetail.id}`);
    expect(designHash(d.decisions!)).toBe(d.hash);
    const r = await app.request(`/api/runs/${RUN}/designs/${withDetail.id}/detail`);
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Detail-Status')).toBe('precomputed');
    const det = (await r.json()) as DesignDetail;
    expect(det.designHash).toBe(d.hash);
    await get(`/api/runs/nope`, 404);
    await get(`/api/runs/${RUN}/designs/nope`, 404);
  });

  it('a design without a precomputed detail: missing, then simulated by the dummy simulator and cached', async () => {
    const list = await get<DesignList>(`/api/runs/${RUN}/designs`);
    const other = list.designs.find((d) => !d.hasDetail)!;
    const r0 = await app.request(`/api/runs/${RUN}/designs/${other.id}/detail`);
    expect(r0.status).toBe(404);
    expect(r0.headers.get('X-Detail-Status')).toBe('missing');
    const r1 = await app.request(`/api/runs/${RUN}/designs/${other.id}/detail?simulate=1`);
    expect(r1.headers.get('X-Detail-Status')).toBe('simulated');
    const r2 = await app.request(`/api/runs/${RUN}/designs/${other.id}/detail`);
    expect(r2.headers.get('X-Detail-Status')).toBe('cached');
  });

  it('no Verify files, no input model, no source trees', async () => {
    for (const name of ['parts', 'causes', 'chains', 'other']) await get(`/api/packets/${ID}/verify/${name}`, 404);
    await get(`/api/domains/${ID}/model`, 404);
    const dom = await get<{ id: string; classes: unknown[] }>(`/api/domains/${ID}`);
    expect(dom.classes.length).toBeGreaterThanOrEqual(4);
    const e = await get<{ error: string }>(`/api/packets/${ID}/sources/code`, 404);
    expect(e.error).toMatch(/no source tree code/);
  });
});

describe('commands and the local configuration', () => {
  it('a packet runs nothing by default', async () => {
    expect(LocalConfig.of(false).allows(ID, 'simulate')).toBe(false);
    const dir = copyFixture((m) => { m.commands = { simulate: { argv: ['echo', '{model}'] }, rebuild: { argv: ['echo'] } }; });
    const reg = await registryOf([dir]);
    const pk = reg.packet(ID)!;
    expect(pk.allowedCommands()).toEqual([]);
    expect(pk.command('simulate')).toBeUndefined();
    expect(() => pk.prepare('simulate')).toThrow(/does not allow/);
    expect(() => pk.prepare('nope')).toThrow(/has no command nope/);
    expect(reg.index().packets![0].allowedCommands).toEqual([]);
  });

  it('allow lists: server.local.json and EXPLORER_ALLOW_COMMANDS', () => {
    const file = path.join(tmp, 'server.local.json');
    fs.writeFileSync(file, JSON.stringify({ allowCommands: { a: ['simulate'], b: true, c: false } }));
    const cfg = new LocalConfig('/nowhere', { EXPLORER_LOCAL_CONFIG: file, EXPLORER_ALLOW_COMMANDS: 'a:rebuild, d:simulate+rebuild,e,' });
    expect(cfg.file).toBe(file);
    expect(cfg.allows('a', 'simulate')).toBe(true);
    expect(cfg.allows('a', 'rebuild')).toBe(true);
    expect(cfg.allows('a', 'other')).toBe(false);
    expect(cfg.allows('b', 'anything')).toBe(true);
    expect(cfg.allows('c', 'simulate')).toBe(false);
    expect(cfg.allows('d', 'simulate') && cfg.allows('d', 'rebuild')).toBe(true);
    expect(cfg.allows('d', 'other')).toBe(false);
    expect(cfg.allows('e', 'anything')).toBe(true);
    expect(cfg.allows('f', 'simulate')).toBe(false);
    // the root's server.local.json when no EXPLORER_LOCAL_CONFIG is set
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    fs.writeFileSync(path.join(root, 'server.local.json'), JSON.stringify({ allowCommands: true }));
    expect(new LocalConfig(root, {}).allows('any', 'thing')).toBe(true);
    expect(new LocalConfig(path.join(tmp, 'none'), {}).file).toBeNull();
    expect(LocalConfig.of(true).allows('x', 'y')).toBe(true);
    expect(LocalConfig.of({ x: ['y'] }).allows('x', 'z')).toBe(false);
  });

  it('prepare fills the placeholders: the packet, the roots, the given variables, array arguments', () => {
    const dir = copyFixture((m) => {
      m.roots = { tools: 'bin', up: '..' };
      m.commands = { simulate: { argv: ['{tools}/run.sh', '--model', '{model}', '{diff}', 'in={packet}', '{unknown}'], cwd: 'tools', env: { OUT: '{out}' }, timeoutS: 5 } };
    });
    const pk = new Packet(dir, Packet.readManifest(dir), { id: ID, domains: [ID] }, LocalConfig.of({ [ID]: ['simulate'] }));
    expect(pk.allowedCommands()).toEqual(['simulate']);
    const p = pk.prepare('simulate', { model: 'm.json', diff: ['--a', '--b'], out: '/o' });
    expect(p.file).toBe(path.join(dir, 'bin/run.sh'));
    expect(p.args).toEqual(['--model', 'm.json', '--a', '--b', `in=${dir}`, '{unknown}']);
    expect(p.cwd).toBe(path.join(dir, 'bin'));
    expect(p.env.OUT).toBe('/o');
    expect(p.timeoutMs).toBe(5000);
    expect(pk.root('up')).toBe(path.dirname(dir));
  });

  it('runs an allowed command to its end', async () => {
    const dir = copyFixture((m) => { m.commands = { simulate: { argv: [process.execPath, '-e', 'console.log(process.argv[1])', '{model}'] } }; });
    const pk = new Packet(dir, Packet.readManifest(dir), { id: ID, domains: [ID] }, LocalConfig.of({ [ID]: true }));
    expect((await pk.run('simulate', { model: 'x.json' })).stdout.trim()).toBe('x.json');
  });

  it('rejects a packet of another contract major', async () => {
    const major = Number(CONTRACT_VERSION.split('.')[0]);
    const dir = copyFixture((m) => { m.contract = `${major + 1}.0.0`; m.id = 'future'; });
    expect(() => Packet.readManifest(dir)).toThrow(/contract \d+\.0\.0, the explorer reads/);
    const reg = await registryOf([dir]);
    const st = reg.index().sources[0];
    expect(st.ok).toBe(false);
    expect(st.message).toMatch(/contract/);
    expect(reg.packet('future')).toBeNull();
    // nor are its runs and domains served (under an implicit packet)
    expect(reg.index().runs).toEqual([]);
    expect(reg.packets()).toEqual([]);
    // a manifest without an id is no packet either
    const noId = copyFixture((m) => { (m as Partial<PacketManifest>).id = undefined; });
    expect(() => Packet.readManifest(noId)).toThrow(/no id/);
  });
});

describe('staleness', () => {
  it('a changed input makes the packet stale', async () => {
    const dir = copyFixture();
    const reg = await registryOf([dir]);
    expect(reg.packet(ID)!.freshness()).toEqual({ state: 'current', changed: [] });
    fs.appendFileSync(path.join(dir, 'inputs/shop.md'), '\nA seventh class.\n');
    expect(reg.packet(ID)!.summary().stale).toEqual(['inputs/shop.md']);
    expect(reg.index().packets![0].stale).toEqual(['inputs/shop.md']);
    expect(reg.packet(ID)!.freshness()).toMatchObject({ state: 'stale', changed: ['inputs/shop.md'] });
  });

  it('with rebuild allowed: updating, then current (the registry reads the rebuilt packet)', async () => {
    // the rebuild records the inputs' new hashes
    const script = "const fs=require('fs'),c=require('crypto');const m=JSON.parse(fs.readFileSync('packet.json','utf8'));for(const i of m.inputs)i.hash=c.createHash('sha256').update(fs.readFileSync(i.path)).digest('hex').slice(0,16);m.builtAt=new Date().toISOString();fs.writeFileSync('packet.json',JSON.stringify(m))";
    const dir = copyFixture((m) => { m.commands = { rebuild: { argv: [process.execPath, '-e', script] } }; });
    const reg = await registryOf([dir], LocalConfig.of({ [ID]: ['rebuild'] }));
    const before = reg.packet(ID)!;
    expect(before.allowedCommands()).toEqual(['rebuild']);
    fs.appendFileSync(path.join(dir, 'inputs/shop.md'), '\nA seventh class.\n');
    expect(before.freshness().state).toBe('updating');
    expect(before.freshness().state).toBe('updating');
    for (let i = 0; i < 100 && reg.packet(ID) === before; i++) await new Promise((r) => setTimeout(r, 50));
    const after = reg.packet(ID)!;
    expect(after).not.toBe(before);
    expect(after.manifest.inputs![0].hash).toBe(sha16(path.join(dir, 'inputs/shop.md')));
    expect(after.freshness()).toEqual({ state: 'current', changed: [] });
  });

  it('a failing rebuild reports failed with its error', async () => {
    const dir = copyFixture((m) => { m.commands = { rebuild: { argv: [process.execPath, '-e', "console.error('no luck'); process.exit(3)"] } }; });
    const pk = new Packet(dir, Packet.readManifest(dir), { id: ID, domains: [ID] }, LocalConfig.of({ [ID]: ['rebuild'] }));
    fs.appendFileSync(path.join(dir, 'inputs/shop.md'), 'x');
    expect(pk.freshness().state).toBe('updating');
    let f = pk.freshness();
    for (let i = 0; i < 100 && f.state === 'updating'; i++) { await new Promise((r) => setTimeout(r, 50)); f = pk.freshness(); }
    expect(f.state).toBe('failed');
    expect(f.error).toMatch(/exited with 3: no luck/);
  });
});

describe('source trees', () => {
  it('dir: only the allowed prefixes, no escapes', async () => {
    const root = path.join(tmp, 'tree');
    for (const [f, t] of [['lib/a.ts', 'export const a = 1;\n'], ['lib/deep/b.md', '# b\n'], ['secret/key.txt', 'no'], ['library/c.ts', 'c'], ['lib/.hidden/x', 'x']]) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), t);
    }
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside');
    const t = new SourceTreeReader('code', { kind: 'dir', label: 'the code', path: '.', allow: ['lib/'] }, root);
    expect([...t.tree()].sort()).toEqual(['lib/a.ts', 'lib/deep/b.md']);
    expect(t.file('lib/a.ts')).toEqual({ tree: 'code', path: 'lib/a.ts', text: 'export const a = 1;\n' });
    for (const bad of ['secret/key.txt', 'library/c.ts', 'lib/../secret/key.txt', '../outside.txt', 'lib/../../outside.txt', path.join(tmp, 'outside.txt'), ''])
      expect(() => t.file(bad), bad).toThrow();
    // no way out through a symbolic link (a file or a directory under an allowed prefix)
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'lib/out.txt'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'lib/secret'));
    expect(() => t.file('lib/out.txt')).toThrow();
    expect(() => t.file('lib/secret/key.txt')).toThrow();
    expect([...new SourceTreeReader('code', { kind: 'dir', label: 'the code', path: '.', allow: ['lib/'] }, root).tree()].sort()).toEqual(['lib/a.ts', 'lib/deep/b.md']);
    fs.unlinkSync(path.join(root, 'lib/out.txt'));
    fs.unlinkSync(path.join(root, 'lib/secret'));
    // the working tree as it is now
    fs.writeFileSync(path.join(root, 'lib/a.ts'), 'changed');
    expect(t.file('lib/a.ts').text).toBe('changed');
    // without allow: every file (no dot directories)
    const all = new SourceTreeReader('all', { kind: 'dir', label: 'all', path: '.' }, root);
    expect([...all.tree()].sort()).toEqual(['lib/a.ts', 'lib/deep/b.md', 'library/c.ts', 'secret/key.txt']);
  });

  it('git: the files at a commit', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'src/shop.ts'), 'v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src/shop.ts'), 'v2\n');
    fs.writeFileSync(path.join(repo, 'src/later.ts'), 'later\n');
    git('add', '.');
    git('commit', '-q', '-m', 'two');
    const t = new SourceTreeReader('code', { kind: 'git', label: 'the shop', path: '.', ref: first }, repo);
    expect([...t.tree()]).toEqual(['src/shop.ts']);
    expect(t.file('src/shop.ts')).toEqual({ tree: 'code', path: 'src/shop.ts', commit: first, text: 'v1\n' });
    expect(() => t.file('src/later.ts')).toThrow(/no file src\/later.ts/);
    expect(() => t.file('../x')).toThrow(/not a path/);
    const none = new SourceTreeReader('code', { kind: 'git', label: 'the shop', path: '.', ref: '0'.repeat(40) }, repo);
    expect(() => none.tree()).toThrow(/has no commit/);
  });

  it('served by the API from the packet\'s trees', async () => {
    const dir = copyFixture((m) => { m.roots = { code: 'code' }; m.sources = { code: { kind: 'dir', label: 'the code', root: 'code', path: '.', allow: ['src/'] } }; });
    fs.mkdirSync(path.join(dir, 'code/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'code/src/a.ts'), 'a');
    fs.writeFileSync(path.join(dir, 'code/other.ts'), 'o');
    const app = createApp(await registryOf([dir]));
    expect(await (await app.request(`/api/packets/${ID}/sources/code`)).json()).toEqual({ files: ['src/a.ts'] });
    expect(await (await app.request(`/api/packets/${ID}/sources/code/file?path=src/a.ts`)).json()).toEqual({ tree: 'code', path: 'src/a.ts', text: 'a' });
    expect((await app.request(`/api/packets/${ID}/sources/code/file?path=other.ts`)).status).toBe(404);
    expect((await app.request(`/api/packets/${ID}/sources/code/file?path=../packet.json`)).status).toBe(404);
  });
});
