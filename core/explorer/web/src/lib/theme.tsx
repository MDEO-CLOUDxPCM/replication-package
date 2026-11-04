import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const Ctx = createContext<{ pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void }>({ pref: 'system', theme: 'light', setPref: () => {} });

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    try { return (localStorage.getItem('explorer-theme') as ThemePref) || 'system'; } catch { return 'system'; }
  });
  const [sys, setSys] = useState(systemDark());
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSys(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const theme: Theme = pref === 'system' ? (sys ? 'dark' : 'light') : pref;
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('dark', theme === 'dark');
    el.dataset.theme = theme;
  }, [theme]);
  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try { localStorage.setItem('explorer-theme', p); } catch { /* private mode */ }
  };
  return <Ctx.Provider value={{ pref, theme, setPref }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
