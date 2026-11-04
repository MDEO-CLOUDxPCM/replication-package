/**
 * The backend's LOCAL configuration (never part of a packet, gitignored): which packets may run which of their
 * commands. A packet declares commands (packet.json `commands`: simulate, rebuild); the backend runs one only when
 * this configuration allows it, so a packet from elsewhere cannot make the backend run anything.
 *
 *   server.local.json (explorer/, or EXPLORER_LOCAL_CONFIG):
 *     { "allowCommands": { "<packet id>": ["simulate", "rebuild"] | true } }   or   { "allowCommands": true } (every packet)
 *   EXPLORER_ALLOW_COMMANDS="<packet>[:<cmd>+<cmd>],…" adds to it ("shop:simulate+rebuild", "shop" = all of its commands)
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LocalConfigFile {
  allowCommands?: boolean | Record<string, boolean | string[]>;
}

export class LocalConfig {
  private allow = new Map<string, Set<string> | true>();
  private all = false;
  readonly file: string | null;

  constructor(root: string, env: NodeJS.ProcessEnv = process.env) {
    const f = env.EXPLORER_LOCAL_CONFIG ? path.resolve(env.EXPLORER_LOCAL_CONFIG) : path.join(root, 'server.local.json');
    this.file = fs.existsSync(f) ? f : null;
    if (this.file) {
      const cfg = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LocalConfigFile;
      if (cfg.allowCommands === true) this.all = true;
      else for (const [id, v] of Object.entries(cfg.allowCommands || {})) if (v) this.allow.set(id, v === true ? true : new Set(v));
    }
    for (const item of (env.EXPLORER_ALLOW_COMMANDS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const [id, cmds] = item.split(':');
      if (!cmds) { this.allow.set(id, true); continue; }
      const cur = this.allow.get(id);
      if (cur === true) continue;
      this.allow.set(id, new Set([...(cur ?? []), ...cmds.split('+').filter(Boolean)]));
    }
  }

  allows(packet: string, command: string): boolean {
    if (this.all) return true;
    const a = this.allow.get(packet);
    return a === true || !!a?.has(command);
  }

  /** a configuration that allows nothing (tests) or what is given */
  static of(allow: LocalConfigFile['allowCommands']): LocalConfig {
    const c = new LocalConfig('/nonexistent', { EXPLORER_LOCAL_CONFIG: '/nonexistent/none.json' });
    if (allow === true) c.all = true;
    else for (const [id, v] of Object.entries(allow || {})) if (v) c.allow.set(id, v === true ? true : new Set(v));
    return c;
  }
}
