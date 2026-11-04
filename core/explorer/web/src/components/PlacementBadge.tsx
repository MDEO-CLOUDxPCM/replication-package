/**
 * Where the two sides of a call run (contract Placement, 1.12.0), never a mechanism: **no hop** (caller and callee in
 * one container: a direct call) or **remote → <service>** (different containers: the hop). And **own data**: an
 * operation's access to its own home class (no call site, no decision), the third placement: always shown with
 * its fixed mechanism, a read `sync`, a write `in transaction` (the operation's own transaction). One wording everywhere:
 * the call tree, the operations list, an operation's and a class's details, the Architecture panel, the compare.
 * The packet's texts `placement.noHop`, `placement.remote` and `placement.own` explain them (else the defaults below).
 */
import { useTexts } from '@/lib/packet';
import { cn } from '@/lib/utils';
import { MechChip } from '@/model/shared';

export const PLACEMENT_ABOUT = {
  noHop: 'a direct call: no middleware, no network, no receiving envelope; an asynchronous message stays in-process (no broker)',
  remote: "the hop: both sidecars' middleware and the network; a synchronous call also pays the callee's receiving envelope, an asynchronous message goes through the broker",
  own: "the operation's own home class: its own schema, called directly on the database server; no call site: a read sync, a write in the operation's own transaction; no hop",
} as const;

/** the badge's text: `no hop`, `remote → <service>` (or `remote` when the callee's service is not known) */
export const placementLabel = (together: boolean, to?: string) => (together ? 'no hop' : `remote${to ? ` → ${to}` : ''}`);

export function usePlacementAbout(): (k: keyof typeof PLACEMENT_ABOUT) => string {
  const tx = useTexts();
  return (k) => tx(`placement.${k}`) || PLACEMENT_ABOUT[k];
}

/** `together`: caller and callee in one container; `to`: the callee's service; `where`: the placement (design A, today) */
export function PlacementBadge({ together, to, where, className }: { together: boolean; to?: string; where?: string; className?: string }) {
  const about = usePlacementAbout();
  const title = `${together ? 'caller and callee in one container' : `caller and callee in different containers${to ? ` (callee in ${to})` : ''}`}${where ? ` in ${where}` : ''}: ${about(together ? 'noHop' : 'remote')}`;
  return (
    <span data-placement={together ? 'noHop' : 'remote'} title={title}
      className={cn('inline-block max-w-[14rem] shrink-0 truncate whitespace-nowrap rounded px-1 align-middle text-[10px] leading-4',
        together ? 'bg-muted text-muted-foreground' : 'bg-[color-mix(in_oklab,var(--status-warning)_16%,transparent)] text-foreground', className)}>
      {placementLabel(together, to)}
    </span>
  );
}

/** an access to the operation's own home class: the placement badge (shown with its mechanism, `OwnData`) */
export function OwnDataBadge({ className }: { className?: string }) {
  const about = usePlacementAbout();
  return (
    <span data-placement="own" title={about('own')}
      className={cn('inline-block shrink-0 whitespace-nowrap rounded border border-dashed px-1 align-middle text-[10px] leading-4 text-muted-foreground', className)}>
      own data
    </span>
  );
}

/** own data's fixed mechanism: a read sync, a write in the operation's own transaction */
export const ownMech = (mode?: string) => (mode === 'write' ? 'inTx' : 'sync');

/**
 * own data with its mechanism: the fixed chip (a read `sync`, a write `in transaction`) and the badge, never
 * one without the other. `option`: the own option of a decision (Verify's home options), `active` today's; else fixed.
 */
export function OwnData({ mode, option, active = true, title, className }: { mode?: string; option?: boolean; active?: boolean; title?: string; className?: string }) {
  const write = mode === 'write';
  const what = write ? "a write in the operation's own transaction" : "a synchronous read in the operation's transaction";
  const t = title ?? (option ? `own data (while its class is the home): ${what}` : `fixed, no call site: own data, ${what}`);
  return (
    <span data-own={write ? 'write' : 'read'} title={t} className={cn('inline-flex shrink-0 items-center gap-1 align-middle', className)}>
      <MechChip m={ownMech(mode)} active={active} muted={!active} title={t} />
      <OwnDataBadge className={cn(!active && 'opacity-60')} />
    </span>
  );
}
