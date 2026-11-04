import type { PlanVia } from './types';

/** (1.12.0) a request plan entry's `via` as PlanVia: accepts the older spelling `local` for `service` */
export const planVia = (v: string | undefined): PlanVia | undefined => (v === 'local' ? 'service' : (v as PlanVia | undefined));
