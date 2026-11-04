import { describe, expect, it } from 'vitest';
import { closePanels, encodeSel, fitPanels, formatPanels, parsePanels, resolveSel, toSearch, PANEL_MIN, RAIL_WIDTH } from '../web/src/lib/workspace';
import { formatArea, markedBy, parseArea, parseAreas } from '../web/src/lib/areas';

describe('panels', () => {
  it('parses and formats the open panels; Runs is always open', () => {
    expect(parsePanels('perf,designs')).toEqual(['runs', 'designs', 'perf']);
    expect(parsePanels('runs')).toEqual(['runs']);
    expect(parsePanels(null)).toBeNull();
    expect(formatPanels(['runs', 'arch', 'designs'])).toBe('designs,arch');
    expect(formatPanels(['runs'])).toBe('runs');
  });
  it('closing a panel closes the panels to its right, never Runs', () => {
    expect(closePanels(['runs', 'designs', 'arch', 'perf'], 'designs')).toEqual(['runs']);
    expect(closePanels(['runs', 'designs', 'arch', 'perf'], 'perf')).toEqual(['runs', 'designs', 'arch']);
    expect(closePanels(['runs', 'perf'], 'runs')).toEqual(['runs', 'perf']);
  });
  it('the Model panel stays when the drill-down closes, and closes by itself', () => {
    expect(closePanels(['runs', 'designs', 'arch', 'model'], 'designs')).toEqual(['runs', 'model']);
    expect(closePanels(['runs', 'designs', 'arch', 'model'], 'model')).toEqual(['runs', 'designs', 'arch']);
    expect(parsePanels('model,designs')).toEqual(['runs', 'designs', 'model']);
  });
  it('fits every open panel when there is room', () => {
    expect(fitPanels(['runs', 'designs', 'arch', 'perf'], 1920, null)).toEqual(['runs', 'designs', 'arch', 'perf']);
  });
  it('collapses from the left when the minimum widths do not fit', () => {
    expect(fitPanels(['runs', 'designs', 'arch', 'perf'], 1100, null)).toEqual(['arch', 'perf']);
    expect(fitPanels(['runs', 'designs', 'arch'], 1100, 'arch')).toEqual(['designs', 'arch']);
    expect(fitPanels(['runs', 'designs', 'arch', 'perf'], 1440, null)).toEqual(['arch', 'perf']);
  });
  it('keeps the focused panel and collapses the next one from the left', () => {
    expect(fitPanels(['runs', 'designs', 'arch', 'perf'], 1100, 'designs')).toEqual(['designs', 'perf']);
  });
  it('panels the user collapsed stay rails', () => {
    expect(fitPanels(['runs', 'designs', 'arch'], 1920, null, ['runs'])).toEqual(['designs', 'arch']);
  });
  it('a single panel always shows', () => {
    expect(fitPanels(['runs', 'perf'], 400, null)).toEqual(['perf']);
    const w = PANEL_MIN.arch + RAIL_WIDTH;
    expect(fitPanels(['runs', 'arch'], w, null)).toEqual(['arch']);
  });
});

describe('selection references', () => {
  it('is relative to the workspace run unless it names another', () => {
    expect(resolveSel('abc', 'r1')).toEqual({ runId: 'r1', designId: 'abc' });
    expect(resolveSel('r2~abc', 'r1')).toEqual({ runId: 'r2', designId: 'abc' });
    expect(encodeSel({ runId: 'r1', designId: 'abc' }, 'r1')).toBe('abc');
    expect(encodeSel({ runId: 'r2', designId: 'abc' }, 'r1')).toBe('r2~abc');
  });
  it('writes readable query strings', () => {
    expect(toSearch(new URLSearchParams([['p', 'designs,arch'], ['b', 'r~x y']]))).toBe('?p=designs,arch&b=r~x%20y');
  });
});

describe('marked areas', () => {
  it('round-trips through the URL form', () => {
    const a = { x: 'cost', y: 'failure', x0: 40.123456789, x1: 50, y0: 3000, y1: 4500 };
    expect(parseArea(formatArea(a))).toEqual({ ...a, x0: 40.1235 });
    expect(parseArea('cost,failure,5,1,9,2')).toEqual({ x: 'cost', y: 'failure', x0: 1, x1: 5, y0: 2, y1: 9 });
    expect(parseAreas(['bad', 'a,b,1,2,3,x'])).toEqual([]);
  });
  it('marks the designs inside any area', () => {
    const ds = [{ id: 'p', v: [1, 1] }, { id: 'q', v: [5, 5] }, { id: 'r', v: [9, 9] }];
    const get = (k: string) => (k === 'x' ? (d: { v: number[] }) => d.v[0] : k === 'y' ? (d: { v: number[] }) => d.v[1] : undefined);
    const areas = [{ x: 'x', y: 'y', x0: 0, x1: 2, y0: 0, y1: 2 }, { x: 'x', y: 'y', x0: 8, x1: 10, y0: 8, y1: 10 }, { x: 'z', y: 'y', x0: 0, x1: 99, y0: 0, y1: 99 }];
    expect([...markedBy(ds, areas, get)]).toEqual(['p', 'r']);
  });
});
