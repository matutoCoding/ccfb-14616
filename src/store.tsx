import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { idbDeleteRun, idbGetAllRuns, idbGetRun, idbGetAllSchemes, idbPutRun, idbPutScheme } from './db';
import { createDefaultScheme } from './data/defaults';
import type { RunSummary, Scheme } from './types';

interface StudioState {
  ready: boolean;
  schemes: Scheme[];
  scheme: Scheme;
  runs: RunSummary[];
  currentRunId: string | null;
  currentRun: RunSummary | null;
  setCurrentSchemeId: (id: string) => void;
  updateScheme: (mutator: (draft: Scheme) => void) => void;
  replaceScheme: (scheme: Scheme) => void;
  saveSchemeNow: () => Promise<void>;
  addScheme: (scheme: Scheme) => Promise<void>;
  addRun: (run: RunSummary) => Promise<void>;
  removeRun: (id: string) => Promise<void>;
  loadRun: (id: string) => Promise<RunSummary | undefined>;
  setCurrentRunId: (id: string | null) => void;
  reloadRuns: () => Promise<void>;
}

const Ctx = createContext<StudioState | null>(null);
const CURRENT_SCHEME_KEY = 'ess-studio-current-scheme';
const CURRENT_RUN_KEY = 'ess-studio-current-run';

export function StudioProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [schemeId, setSchemeId] = useState<string>('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRunId, setCurrentRunIdState] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = await idbGetAllSchemes();
      if (!loaded.length) {
        const seed = createDefaultScheme();
        await idbPutScheme(seed);
        loaded = [seed];
      }
      if (cancelled) return;
      const savedSchemeId = localStorage.getItem(CURRENT_SCHEME_KEY);
      const initial = loaded.find((s) => s.id === savedSchemeId) ?? loaded[0];
      setSchemes(loaded);
      setSchemeId(initial.id);
      const loadedRuns = await idbGetAllRuns();
      if (cancelled) return;
      setRuns(loadedRuns);
      const savedRunId = localStorage.getItem(CURRENT_RUN_KEY);
      const initialRunId = savedRunId && loadedRuns.some((r) => r.id === savedRunId) ? savedRunId : loadedRuns[0]?.id ?? null;
      setCurrentRunIdState(initialRunId);
      if (initialRunId) {
        const fullRun = await idbGetRun(initialRunId);
        if (fullRun && !cancelled) setRuns((prev) => prev.map((r) => (r.id === fullRun.id ? fullRun : r)));
      }
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const scheme = useMemo(() => schemes.find((s) => s.id === schemeId) ?? schemes[0] ?? createDefaultScheme(), [schemes, schemeId]);
  const currentRun = useMemo(() => runs.find((r) => r.id === currentRunId) ?? null, [runs, currentRunId]);

  const persist = useCallback((next: Scheme) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void idbPutScheme(next); }, 350);
  }, []);

  const updateScheme = useCallback((mutator: (draft: Scheme) => void) => {
    setSchemes((prev) => {
      const current = prev.find((s) => s.id === schemeId) ?? prev[0];
      if (!current) return prev;
      const draft = structuredClone(current);
      mutator(draft);
      draft.updatedAt = Date.now();
      const nextList = prev.some((s) => s.id === draft.id)
        ? prev.map((s) => (s.id === draft.id ? draft : s))
        : [draft, ...prev];
      persist(draft);
      return nextList;
    });
  }, [schemeId, persist]);

  const replaceScheme = useCallback((next: Scheme) => {
    setSchemes((prev) => prev.map((s) => (s.id === next.id ? next : s)));
    void idbPutScheme(next);
  }, []);

  const saveSchemeNow = useCallback(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await idbPutScheme(scheme);
  }, [scheme]);

  const addScheme = useCallback(async (next: Scheme) => {
    setSchemes((prev) => [next, ...prev]);
    setSchemeId(next.id);
    localStorage.setItem(CURRENT_SCHEME_KEY, next.id);
    await idbPutScheme(next);
  }, []);

  const setCurrentSchemeId = useCallback((id: string) => {
    setSchemeId(id);
    localStorage.setItem(CURRENT_SCHEME_KEY, id);
  }, []);

  const addRun = useCallback(async (run: RunSummary) => {
    setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
    setCurrentRunIdState(run.id);
    localStorage.setItem(CURRENT_RUN_KEY, run.id);
    await idbPutRun(run);
  }, []);

  const removeRun = useCallback(async (id: string) => {
    await idbDeleteRun(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const full = await idbGetRun(id);
    if (full) setRuns((prev) => prev.map((r) => (r.id === id ? full : r)));
    return full;
  }, []);

  const setCurrentRunId = useCallback((id: string | null) => {
    setCurrentRunIdState(id);
    if (id) localStorage.setItem(CURRENT_RUN_KEY, id);
  }, []);

  const reloadRuns = useCallback(async () => {
    setRuns(await idbGetAllRuns());
  }, []);

  const value: StudioState = {
    ready, schemes, scheme, runs, currentRunId, currentRun,
    setCurrentSchemeId, updateScheme, replaceScheme, saveSchemeNow,
    addScheme, addRun, removeRun, loadRun, setCurrentRunId, reloadRuns,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStudio(): StudioState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStudio must be used inside StudioProvider');
  return ctx;
}
