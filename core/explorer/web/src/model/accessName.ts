import type { ModelAccess, ModelOperation } from '@contract/types';

/** what an access touches: the reference it reads or writes (`Class.reference`), else its class */
export const accessName = (a: Pick<ModelAccess, 'class' | 'via'>) => a.via ?? a.class;

/** what an operation's accesses of one class and mode touch: `Class`, `Class.reference` or both; the class without any */
export function accessesName(op: ModelOperation | undefined, cls: string, mode: string): string {
  const names = [...new Set((op?.accesses ?? []).filter((a) => a.class === cls && a.mode === mode).map(accessName))];
  return names.length ? names.join(', ') : cls;
}
