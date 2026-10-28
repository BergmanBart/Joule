import { create } from 'zustand';
import {
  cloneWithNewIds,
  defaultUse,
  filterSteps,
  findStep,
  insertSteps,
  moveSteps,
  newId,
  newKeyword,
  newStep,
  newTest,
  positionOf,
  recordedStep,
  resolveParameters,
  subtreeIds,
  updateStep,
  walk,
  type AppSettings,
  type ElementDescriptor,
  type Keyword,
  type Locator,
  type Project,
  type RobotTestResult,
  type Step,
  type Test,
} from '@uitester/core';
import { api } from './api';

export type Modal =
  | { kind: 'start' }
  | { kind: 'folder'; purpose: 'open' | 'new' }
  | { kind: 'new'; dir: string }
  | { kind: 'params' }
  | { kind: 'settings'; tab?: 'general' | 'runplan' | 'deps' }
  | { kind: 'app' }
  | { kind: 'test'; testId: string }
  | null;

export interface StepRunState {
  status: 'running' | 'pass' | 'fail' | 'skip';
  message?: string;
}

/** The step list currently shown in the steps column: a test or a reusable keyword. */
export type Container = { kind: 'test' | 'keyword'; id: string };

export interface RunState {
  kind?: 'live' | 'robot';
  running: boolean;
  paused?: { stepId?: string; message?: string };
  steps: Record<string, StepRunState>;
  output: string[];
  results?: RobotTestResult[];
  logDir?: string;
  ok?: boolean;
  message?: string;
  testIds: string[];
}

/** Where the next recorded click goes: a new step, or the locator of an existing step. */
export type PickTarget = { stepId: string; field: 'wait' | 'condition' | 'element' } | null;

interface State {
  connected: boolean;
  settings: AppSettings;
  home: string;
  projectDir?: string;
  project?: Project;
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  externalEdits: string[];
  warnings: string[];
  past: Project[];
  future: Project[];

  current?: Container;
  selected: string[];
  anchor?: string;
  detail?: string;
  pickTarget: PickTarget;

  view: { status: 'idle' | 'starting' | 'ready' | 'closed' | 'error'; url: string; message?: string; mode: 'record' | 'interact' };
  run: RunState;
  outputOpen: boolean;
  modal: Modal;
  toast?: { text: string; kind: 'info' | 'error' };
}

const emptyRun: RunState = { running: false, steps: {}, output: [], testIds: [] };

export const useStore = create<State>(() => ({
  connected: false,
  settings: { recent: [] },
  home: '',
  dirty: false,
  saving: false,
  externalEdits: [],
  warnings: [],
  past: [],
  future: [],
  selected: [],
  pickTarget: null,
  view: { status: 'idle', url: '', mode: 'record' },
  run: emptyRun,
  outputOpen: false,
  modal: null,
}));

const get = useStore.getState;
const set = useStore.setState;

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  set({ toast: { text, kind } });
  setTimeout(() => {
    if (get().toast?.text === text) set({ toast: undefined });
  }, kind === 'error' ? 6000 : 3000);
}

export async function call<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

// ---------- project lifecycle ----------

export function loadProject(dir: string, project: Project, extra: { externalEdits?: string[]; warnings?: string[] } = {}) {
  const first = project.tests[0];
  set({
    projectDir: dir,
    project,
    dirty: false,
    externalEdits: extra.externalEdits ?? [],
    warnings: extra.warnings ?? [],
    past: [],
    future: [],
    current: first ? { kind: 'test', id: first.id } : undefined,
    selected: [],
    detail: undefined,
    run: emptyRun,
    modal: null,
  });
  document.title = `${project.name} · UITester`;
  void startView();
}

export async function openProject(dir: string) {
  const r = await call(api.request('project.open', { dir }));
  if (!r) return;
  loadProject(r.dir, r.project, { externalEdits: r.externalEdits, warnings: r.warnings });
  if (r.imported) {
    toast('Opened Robot files that were not created with UITester. Review the steps, then save.');
    set({ dirty: true });
  }
  set({ settings: { ...get().settings, recent: [r.dir, ...get().settings.recent.filter((d) => d !== r.dir)] } });
}

export function startUrl(): string {
  const { project } = get();
  if (!project) return 'about:blank';
  return resolveParameters(project, currentTest()).find((p) => p.name === 'URL')?.value || 'about:blank';
}

export async function startView() {
  const { project } = get();
  if (!project) return;
  set({ view: { ...get().view, status: 'starting', url: startUrl() } });
  const s = project.settings;
  await call(api.request('view.start', { browser: s.browser, width: s.width, height: s.height, url: startUrl() }));
  await api.request('view.mode', { mode: get().view.mode }).catch(() => {});
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export async function save() {
  const { project, saving } = get();
  if (!project || saving) return;
  clearTimeout(saveTimer);
  set({ saving: true });
  try {
    const saved = await api.request('project.save', { project });
    // Keep edits made while saving; only take the new hashes.
    const now = get().project!;
    set({ project: { ...now, generatedHashes: saved.generatedHashes }, dirty: now !== project, saving: false, saveError: undefined, externalEdits: [] });
  } catch (e) {
    set({ saving: false, saveError: (e as Error).message });
    toast(`Save failed: ${(e as Error).message}`, 'error');
  }
}

/** Apply an edit to the project (undoable); autosaves shortly after. */
export function edit(fn: (p: Project) => Project) {
  const { project, past } = get();
  if (!project) return;
  const next = fn(project);
  if (next === project) return;
  set({ project: next, dirty: true, past: [...past.slice(-99), project], future: [] });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
}

export function undo() {
  const { past, project, future } = get();
  if (!past.length || !project) return;
  set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], dirty: true });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
}

export function redo() {
  const { past, project, future } = get();
  if (!future.length || !project) return;
  set({ project: future[0], future: future.slice(1), past: [...past, project], dirty: true });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
}

// ---------- containers (test / keyword) ----------

export function currentTest(): Test | undefined {
  const { project, current } = get();
  if (!project) return undefined;
  if (current?.kind === 'test') return project.tests.find((t) => t.id === current.id);
  return undefined;
}

export function containerSteps(p: Project | undefined, c: Container | undefined): Step[] {
  if (!p || !c) return [];
  if (c.kind === 'test') return p.tests.find((t) => t.id === c.id)?.steps ?? [];
  return p.keywords.find((k) => k.id === c.id)?.steps ?? [];
}

export function editSteps(fn: (steps: Step[]) => Step[]) {
  const c = get().current;
  if (!c) return;
  edit((p) => {
    if (c.kind === 'test') return { ...p, tests: p.tests.map((t) => (t.id === c.id ? { ...t, steps: fn(t.steps) } : t)) };
    return { ...p, keywords: p.keywords.map((k) => (k.id === c.id ? { ...k, steps: fn(k.steps) } : k)) };
  });
}

export function selectContainer(c: Container) {
  const before = startUrl();
  set({ current: c, selected: [], detail: undefined, anchor: undefined, pickTarget: null });
  const after = startUrl();
  if (before !== after) void api.request('view.navigate', { url: after });
}

export function editTest(id: string, fn: (t: Test) => Test) {
  edit((p) => ({ ...p, tests: p.tests.map((t) => (t.id === id ? fn(t) : t)) }));
}

export function addTest() {
  const p = get().project;
  if (!p) return;
  let n = p.tests.length + 1;
  while (p.tests.some((t) => t.name === `Test${n}`)) n++;
  const t = newTest(`Test${n}`);
  edit((proj) => ({ ...proj, tests: [...proj.tests, t] }));
  selectContainer({ kind: 'test', id: t.id });
}

export function duplicateTest(id: string) {
  const p = get().project;
  const t = p?.tests.find((x) => x.id === id);
  if (!t) return;
  const copy: Test = { ...structuredClone(t), id: newId('t'), name: `${t.name} copy`, steps: cloneWithNewIds(t.steps, () => newId('s')) };
  edit((proj) => {
    const i = proj.tests.findIndex((x) => x.id === id);
    const tests = [...proj.tests];
    tests.splice(i + 1, 0, copy);
    return { ...proj, tests };
  });
  selectContainer({ kind: 'test', id: copy.id });
}

export function deleteTest(id: string) {
  const p = get().project;
  if (!p || p.tests.length <= 1) return toast('A project needs at least one test', 'error');
  edit((proj) => ({
    ...proj,
    tests: proj.tests.filter((t) => t.id !== id),
    settings: { ...proj.settings, runPlan: proj.settings.runPlan.map((s) => ({ tests: s.tests.filter((x) => x !== id) })).filter((s) => s.tests.length) },
  }));
  if (get().current?.id === id) selectContainer({ kind: 'test', id: get().project!.tests[0].id });
}

export function deleteKeyword(id: string) {
  const p = get().project;
  if (!p) return;
  const used = [...p.tests.flatMap((t) => t.steps), ...p.keywords.flatMap((k) => k.steps)];
  const uses = [...walk(used)].filter((w) => w.step.type === 'keywordCall' && w.step.keywordId === id).length;
  if (uses && !confirm(`This keyword is used ${uses} time(s). Delete it and its calls?`)) return;
  const drop = (steps: Step[]) => filterSteps(steps, (s) => !(s.type === 'keywordCall' && s.keywordId === id));
  edit((proj) => ({
    ...proj,
    keywords: proj.keywords.filter((k) => k.id !== id).map((k) => ({ ...k, steps: drop(k.steps) })),
    tests: proj.tests.map((t) => ({ ...t, steps: drop(t.steps) })),
  }));
  if (get().current?.id === id) selectContainer({ kind: 'test', id: get().project!.tests[0].id });
}

// ---------- selection ----------

/** Visible step ids in display order (for shift-range selection). */
export function flatIds(steps: Step[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    out.push(s.id);
    if (s.type === 'group' && !s.collapsed) out.push(...flatIds(s.steps));
    if (s.type === 'if') out.push(...flatIds(s.then), ...flatIds(s.else));
  }
  return out;
}

export function selectStep(id: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const { selected, anchor, project, current } = get();
  if (mods.shift && anchor) {
    const ids = flatIds(containerSteps(project, current));
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      set({ selected: mods.ctrl ? [...new Set([...selected, ...range])] : range, detail: id });
      return;
    }
  }
  if (mods.ctrl) {
    const has = selected.includes(id);
    const next = has ? selected.filter((x) => x !== id) : [...selected, id];
    set({ selected: next, anchor: id, detail: has ? next[next.length - 1] : id });
    return;
  }
  set({ selected: [id], anchor: id, detail: id, pickTarget: null });
}

export function clearSelection() {
  set({ selected: [], detail: undefined, anchor: undefined, pickTarget: null });
}

/** Selected ids plus everything inside selected groups/ifs. */
export function effectiveSelection(steps: Step[], selected: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of selected) {
    const s = findStep(steps, id);
    if (s) subtreeIds(s).forEach((x) => out.add(x));
  }
  return out;
}

// ---------- step editing ----------

/** Where new steps go: inside the selected container, otherwise after the detail step, otherwise at the end. */
function insertionPoint(steps: Step[]): { target: string; index: number } {
  const { detail } = get();
  const s = detail ? findStep(steps, detail) : undefined;
  if (!s) return { target: 'root', index: steps.length };
  if (s.type === 'group' && !s.collapsed) return { target: s.id, index: s.steps.length };
  if (s.type === 'if') return { target: `${s.id}:then`, index: s.then.length };
  const pos = positionOf(steps, s.id);
  return pos ? { target: pos.target, index: pos.index + 1 } : { target: 'root', index: steps.length };
}

export function addSteps(items: Step[], select = true) {
  const steps = containerSteps(get().project, get().current);
  const at = insertionPoint(steps);
  editSteps((s) => insertSteps(s, at.target, at.index, items));
  if (select && items.length) set({ selected: items.map((i) => i.id), detail: items[items.length - 1].id, anchor: items[0].id });
}

export function addStepOfType(type: Parameters<typeof newStep>[0], extra?: { keywordId?: string }) {
  const s = newStep(type, extra);
  addSteps([s]);
  if (type === 'if') set({ pickTarget: { stepId: s.id, field: 'condition' } });
}

export function onPick(descriptor: ElementDescriptor) {
  const { pickTarget, project, current } = get();
  if (!project || !current) return;
  if (pickTarget) {
    const loc: Locator = { props: descriptor, use: defaultUse(descriptor) };
    editSteps((steps) =>
      updateStep(steps, pickTarget.stepId, (s) => {
        if (pickTarget.field === 'condition' && s.type === 'if') return { ...s, condition: { ...s.condition, locator: loc } };
        if (pickTarget.field === 'wait' && s.type === 'wait') return { ...s, wait: { kind: 'element', locator: loc, state: 'visible' } };
        if (pickTarget.field === 'element' && s.type === 'element') return { ...s, locator: loc };
        return s;
      }),
    );
    set({ pickTarget: null });
    return;
  }
  addSteps([recordedStep(descriptor)]);
}

export function updateCurrentStep(id: string, fn: (s: Step) => Step) {
  editSteps((steps) => updateStep(steps, id, fn));
}

export function deleteSelected() {
  const { selected } = get();
  if (!selected.length) return;
  const ids = new Set(selected);
  editSteps((steps) => filterSteps(steps, (s) => !ids.has(s.id)));
  clearSelection();
}

/** Top-most selected steps in tree order (children of selected containers are implied). */
function selectedRoots(steps: Step[]): Step[] {
  const ids = new Set(get().selected);
  const out: Step[] = [];
  const visit = (list: Step[]) => {
    for (const s of list) {
      if (ids.has(s.id)) out.push(s);
      else if (s.type === 'group') visit(s.steps);
      else if (s.type === 'if') {
        visit(s.then);
        visit(s.else);
      }
    }
  };
  visit(steps);
  return out;
}

export function groupSelected() {
  const steps = containerSteps(get().project, get().current);
  const roots = selectedRoots(steps);
  if (!roots.length) return;
  const name = prompt('Group name', 'Group');
  if (name === null) return;
  const pos = positionOf(steps, roots[0].id)!;
  const group: Step = { id: newId('s'), name: name || 'Group', type: 'group', collapsed: false, steps: [] };
  editSteps((s) => moveSteps(insertSteps(s, pos.target, pos.index, [group]), roots.map((r) => r.id), group.id, 0));
  set({ selected: [group.id], detail: group.id, anchor: group.id });
}

export function ungroup(id: string) {
  editSteps((steps) => {
    const g = findStep(steps, id);
    if (!g || g.type !== 'group') return steps;
    const pos = positionOf(steps, id)!;
    return filterSteps(insertSteps(steps, pos.target, pos.index, g.steps), (s) => s.id !== id);
  });
  clearSelection();
}

/** Turn a group into a linked keyword and replace it by a call. */
export function makeReusable(id: string) {
  const steps = containerSteps(get().project, get().current);
  const g = findStep(steps, id);
  if (!g || g.type !== 'group') return;
  const kw = newKeyword(g.name || 'Keyword', g.steps);
  const call: Step = { id: newId('s'), name: '', type: 'keywordCall', keywordId: kw.id };
  const c = get().current!;
  edit((p) => {
    const replace = (list: Step[]) => {
      const pos = positionOf(list, id)!;
      return filterSteps(insertSteps(list, pos.target, pos.index, [call]), (s) => s.id !== id);
    };
    return {
      ...p,
      keywords: [...p.keywords.map((k) => (c.kind === 'keyword' && k.id === c.id ? { ...k, steps: replace(k.steps) } : k)), kw],
      tests: p.tests.map((t) => (c.kind === 'test' && t.id === c.id ? { ...t, steps: replace(t.steps) } : t)),
    };
  });
  set({ selected: [call.id], detail: call.id });
  toast(`"${kw.name}" is now a reusable keyword. Changes to it apply everywhere it is used.`);
}

/** Replace a keyword call with an independent copy of the keyword's steps. */
export function unlinkKeyword(callId: string) {
  const p = get().project!;
  const steps = containerSteps(p, get().current);
  const call = findStep(steps, callId);
  if (!call || call.type !== 'keywordCall') return;
  const kw = p.keywords.find((k) => k.id === call.keywordId);
  if (!kw) return;
  const group: Step = { id: newId('s'), name: kw.name, type: 'group', collapsed: false, steps: cloneWithNewIds(kw.steps, () => newId('s')) };
  editSteps((s) => {
    const pos = positionOf(s, callId)!;
    return filterSteps(insertSteps(s, pos.target, pos.index, [group]), (x) => x.id !== callId);
  });
  set({ selected: [group.id], detail: group.id });
}

export function renameKeyword(id: string, name: string) {
  edit((p) => ({ ...p, keywords: p.keywords.map((k) => (k.id === id ? { ...k, name } : k)) }));
}

export function addKeyword(): Keyword | undefined {
  const name = prompt('Keyword name', 'New keyword');
  if (!name) return undefined;
  const kw = newKeyword(name, []);
  edit((p) => ({ ...p, keywords: [...p.keywords, kw] }));
  selectContainer({ kind: 'keyword', id: kw.id });
  return kw;
}

export function moveSelected(ids: string[], target: string, index: number) {
  editSteps((steps) => moveSteps(steps, ids, target, index));
}

// ---------- clipboard ----------

const CLIP_KEY = 'uitester/steps';
let memoryClipboard = '';

export async function copySelected() {
  const steps = containerSteps(get().project, get().current);
  const roots = selectedRoots(steps);
  if (!roots.length) return;
  const text = JSON.stringify({ [CLIP_KEY]: 1, steps: roots });
  memoryClipboard = text;
  await navigator.clipboard?.writeText(text).catch(() => {});
  toast(`Copied ${roots.length} step(s)`);
}

export async function paste() {
  let text = memoryClipboard;
  try {
    const sys = await navigator.clipboard?.readText();
    if (sys && sys.includes(CLIP_KEY)) text = sys;
  } catch {
    /* clipboard permission denied: use in-app clipboard */
  }
  try {
    const data = JSON.parse(text);
    if (!data[CLIP_KEY]) return;
    const kwIds = new Set(get().project!.keywords.map((k) => k.id));
    const steps = filterSteps(cloneWithNewIds(data.steps as Step[], () => newId('s')), (s) => s.type !== 'keywordCall' || kwIds.has(s.keywordId));
    addSteps(steps);
  } catch {
    /* not our data */
  }
}

// ---------- runs ----------

export function runLive(opts: { stepIds?: string[]; fromStart: boolean }) {
  const { project, current } = get();
  if (!project || !current) return;
  set({ run: { ...emptyRun, kind: 'live', running: true, testIds: [current.id] } });
  void call(api.request('run.live', { project, testId: current.id, stepIds: opts.stepIds, fromStart: opts.fromStart }));
}

export function runRobot(opts: { testIds?: string[]; headless?: boolean }) {
  const { project } = get();
  if (!project) return;
  set({ run: { ...emptyRun, kind: 'robot', running: true, testIds: opts.testIds ?? project.tests.map((t) => t.id) }, outputOpen: true });
  api.request('run.robot', { project, testIds: opts.testIds, headless: opts.headless }).catch((e: Error) => {
    set({ run: { ...get().run, running: false, ok: false } });
    if (e.message.startsWith('DEPS:')) {
      toast(e.message.slice(5).trim() + ' Install it from this dialog.', 'error');
      set({ modal: { kind: 'settings', tab: 'deps' }, outputOpen: false });
    } else toast(e.message, 'error');
  });
}

export function setupEvents() {
  api.onConnection = (connected) => {
    set({ connected });
    if (connected) void init();
  };
  api.on('view.pick', ({ descriptor }) => onPick(descriptor));
  api.on('view.url', ({ url }) => set({ view: { ...get().view, url } }));
  api.on('view.status', ({ state, message }) => set({ view: { ...get().view, status: state, message } }));
  api.on('run.started', ({ kind, testIds }) => set({ run: { ...get().run, kind, running: true, testIds } }));
  api.on('run.step', (e) => set({ run: { ...get().run, steps: { ...get().run.steps, [e.id]: { status: e.status, message: e.message } } } }));
  api.on('run.output', ({ line }) => set({ run: { ...get().run, output: [...get().run.output.slice(-2000), line] } }));
  api.on('run.paused', (p) => set({ run: { ...get().run, paused: p } }));
  api.on('run.resumed', () => set({ run: { ...get().run, paused: undefined } }));
  api.on('run.done', (d) => {
    set({ run: { ...get().run, running: false, paused: undefined, ok: d.ok, logDir: d.logDir, results: d.results, message: d.message } });
    toast(d.ok ? 'Run passed' : `Run failed${d.message ? `: ${d.message}` : ''}`, d.ok ? 'info' : 'error');
  });
}

async function init() {
  const s = await call(api.request('app.state', {}));
  if (!s) return;
  set({ settings: s.settings, home: s.home });
  if (s.project && s.projectDir) {
    if (get().projectDir !== s.projectDir) loadProject(s.projectDir, s.project, { externalEdits: s.externalEdits });
    else void startView();
  } else set({ modal: { kind: 'start' } });
}
