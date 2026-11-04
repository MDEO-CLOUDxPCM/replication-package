import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InputModel } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import type { PacketManifest } from '../contract/packet';
import { LocalConfig } from '../server/local-config';
import { ModelSync } from '../server/model-sync';
import { Packet } from '../server/packets';

/** a packet in a temporary directory: project/ holds the inputs, packet/ the manifest; rebuild writes rebuilt.json */
function setup(allow: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-sync-'));
  fs.mkdirSync(path.join(dir, 'project/models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packet'));
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'project', f))).digest('hex').slice(0, 16);
  const manifest: PacketManifest = {
    contract: CONTRACT_VERSION, id: 'p', name: 'p', domains: ['d'], roots: { project: '../project' },
    commands: { rebuild: { argv: [process.execPath, '-e', 'require("fs").writeFileSync("rebuilt.json", JSON.stringify(process.argv.slice(1)))', '--', '{exportArgs}'], cwd: '.' } },
  };
  const packet = new Packet(path.join(dir, 'packet'), manifest, { id: 'p', domains: ['d'] }, LocalConfig.of(allow ? { p: ['rebuild'] } : {}));
  return { dir, sha, packet };
}

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = []; });

describe('the input model against its inputs (through its packet)', () => {
  it('is current as exported; a model of a packet without manifest is left alone', () => {
    const { dir, sha, packet } = setup(true);
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'project/a.json'), 'a');
    const m = { domainId: 'd', generatedAt: 't', inputs: [{ label: 'a', path: 'a.json', hash: sha('a.json') }] } as unknown as InputModel;
    expect(new ModelSync().check(m, packet)).toEqual({ state: 'current', changed: [], unrealised: [], ungenerated: [] });
    const implicit = new Packet(path.join(dir, 'packet'), null, { id: 'q', domains: ['d'] }, LocalConfig.of(true));
    expect(new ModelSync().check(m, implicit)).toBeUndefined();
  });

  it('reports a seed older than its model, and a model older than its generator inputs as the model file is now, without rebuilding', () => {
    const { dir, sha, packet } = setup(false);
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'project/gen.py'), 'generator');
    fs.writeFileSync(path.join(dir, 'project/seed.m'), 'seed');
    const at = (stamp: string) => fs.writeFileSync(path.join(dir, 'project/models/x.m'), `// Input: gen.py sha256 ${stamp}\nmodel\n`);
    const m = { domainId: 'd', generatedAt: 't', inputs: [{ label: 'seed', path: 'seed.m', hash: sha('seed.m'), source: { path: 'models/x.m', hash: '0000' } }] } as unknown as InputModel;
    at(sha('gen.py'));
    expect(new ModelSync().check(m, packet)).toEqual({ state: 'current', changed: [], unrealised: [{ seed: 'seed.m', source: 'models/x.m' }], ungenerated: [] });
    at('0000');
    expect(new ModelSync().check(m, packet)!.ungenerated).toEqual([{ model: 'models/x.m', inputs: ['gen.py'] }]);
    expect(fs.existsSync(path.join(dir, 'packet/rebuilt.json'))).toBe(false);
  });

  it('a changed input is stale while the local configuration allows no rebuild', () => {
    const { dir, packet } = setup(false);
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'project/a.json'), 'a');
    const m = { domainId: 'd', generatedAt: 't', exportArgs: ['--x'], inputs: [{ label: 'a', path: 'a.json', hash: '0000' }] } as unknown as InputModel;
    const f = new ModelSync().check(m, packet)!;
    expect(f.state).toBe('stale');
    expect(f.changed).toEqual(['a.json']);
    expect(packet.allowedCommands()).toEqual([]);
  });

  it('rebuilds the packet when an input changed and the local configuration allows it, with the arguments recorded', async () => {
    const { dir, sha, packet } = setup(true);
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'project/a.json'), 'a');
    const m = { domainId: 'd', generatedAt: 't', exportArgs: ['--out', 'x'], inputs: [{ label: 'a', path: 'a.json', hash: '0000' }] } as unknown as InputModel;
    const sync = new ModelSync();
    expect(sync.check(m, packet)!.state).toBe('updating');
    // asked again meanwhile: still the one rebuild
    expect(sync.check(m, packet)!.state).toBe('updating');
    const out = path.join(dir, 'packet/rebuilt.json');
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(['--out', 'x']);
    // the rebuilt model records the input as it is now: current once the rebuild has exited
    const fresh = { ...m, inputs: [{ label: 'a', path: 'a.json', hash: sha('a.json') }] } as unknown as InputModel;
    for (let i = 0; i < 40 && sync.check(fresh, packet)!.state === 'updating'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sync.check(fresh, packet)!.state).toBe('current');
  });
});
