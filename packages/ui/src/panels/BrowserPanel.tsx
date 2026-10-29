import { ArrowLeft, Circle, Crosshair, Globe, Hand, Home, Loader2, Play, RotateCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { buildSelector, findStep, interpolate, numberSteps, scopeSelector, walk, type HighlightRequest, type Locator, type Step } from '@joule/core';
import { api } from '../api';
import { containerSteps, currentParams, effectiveSelection, goHome, startUrl, startView, toast, useStore, type PickTarget } from '../store';

/** Locator a step points at in the page (element, element-wait or if-condition). */
export function stepLocator(s: Step): Locator | undefined {
  if (s.type === 'element') return s.locator;
  if (s.type === 'wait' && s.wait.kind === 'element') return s.wait.locator;
  if (s.type === 'if') return s.condition.locator;
  return undefined;
}

/** Selector as the page sees it: ${params} replaced with their current values (random ones as drawn for the open page). */
export function useParams(): Record<string, string> {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const drawn = useStore((s) => s.drawn);
  return useMemo(() => Object.fromEntries(currentParams().map((p) => [p.name, p.value])), [project, current, drawn]);
}

function useHighlightSync() {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const selected = useStore((s) => s.selected);
  const detail = useStore((s) => s.detail);
  const runSteps = useStore((s) => s.run.steps);
  const running = useStore((s) => s.run.running);
  const status = useStore((s) => s.view.status);
  const params = useParams();

  useEffect(() => {
    if (status !== 'ready') return;
    const steps = containerSteps(project, current);
    const numbers = numberSteps(steps);
    const sel = effectiveSelection(steps, selected);
    const runningId = running ? Object.entries(runSteps).filter(([, v]) => v.status === 'running').pop()?.[0] : undefined;
    const items: HighlightRequest[] = [];
    for (const { step } of walk(steps)) {
      const loc = stepLocator(step);
      if (!loc) continue;
      const kind: HighlightRequest['kind'] = step.id === runningId ? 'running' : sel.size ? (sel.has(step.id) ? 'selected' : 'dim') : 'normal';
      items.push({ n: numbers.get(step.id) ?? 0, selector: interpolate(buildSelector(loc), params), kind, all: step.id === detail });
    }
    const t = setTimeout(() => void api.request('view.highlights', { items }).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [project, current, selected, detail, runSteps, running, status, params]);
}

/** While picking part of a "must be inside" scope, only let the overlay pick ancestors (parent) or descendants (contains). */
function usePickConstraint() {
  const pickTarget = useStore((s) => s.pickTarget);
  const status = useStore((s) => s.view.status);
  const params = useParams();
  useEffect(() => {
    const part = pickTarget?.part;
    if (!pickTarget || !part || status !== 'ready') return;
    const { project, current } = useStore.getState();
    const step = findStep(containerSteps(project, current), pickTarget.stepId);
    const loc = step && stepLocator(step);
    const anchor = !loc ? undefined : part.kind === 'parent' ? buildSelector(loc) : loc.within && scopeSelector(loc.within);
    if (!anchor) return;
    const relation = part.kind === 'parent' ? 'ancestor' : 'descendant';
    void api
      .request('view.pickConstraint', { constraint: { selector: interpolate(anchor, params), relation } })
      .then(({ found }) => {
        if (found || useStore.getState().pickTarget !== pickTarget) return;
        toast(part.kind === 'parent' ? 'The element is not on the current page' : 'The parent is not on the current page', 'error');
        useStore.setState({ pickTarget: null });
      })
      .catch(() => {});
    return () => void api.request('view.pickConstraint', { constraint: null }).catch(() => {});
  }, [pickTarget, status]);
}

function pickBanner(t: NonNullable<PickTarget>): string {
  if (t.part?.kind === 'parent') return 'Click a parent of the element (outlined in purple)';
  if (t.part?.kind === 'has') return 'Click an element inside the parent (outlined in purple)';
  return 'Click the element for this step';
}

const BUTTONS = ['left', 'middle', 'right'] as const;

export function BrowserPanel() {
  const view = useStore((s) => s.view);
  const project = useStore((s) => s.project);
  const pickTarget = useStore((s) => s.pickTarget);
  const run = useStore((s) => s.run);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastMove = useRef(0);
  useHighlightSync();
  usePickConstraint();

  useEffect(() => {
    const img = new Image();
    let pending: { data: string; width: number; height: number } | null = null;
    let busy = false;
    const drawNext = () => {
      if (!pending || busy) return;
      const f = pending;
      pending = null;
      busy = true;
      img.onload = () => {
        const c = canvas.current;
        if (c) {
          if (c.width !== f.width || c.height !== f.height) {
            c.width = f.width;
            c.height = f.height;
          }
          c.getContext('2d')!.drawImage(img, 0, 0, f.width, f.height);
        }
        busy = false;
        drawNext();
      };
      img.onerror = () => {
        busy = false;
        drawNext();
      };
      img.src = `data:image/jpeg;base64,${f.data}`;
    };
    return api.on('view.frame', (f) => {
      pending = f; // drop frames we can't draw in time
      drawNext();
    });
  }, []);

  const toPage = (e: React.MouseEvent | React.WheelEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  const setMode = (mode: 'record' | 'interact') => {
    useStore.setState({ view: { ...view, mode } });
    void api.request('view.mode', { mode });
  };

  const recording = view.mode === 'record' && !run.running;
  const robotPaused = run.kind === 'robot' && run.paused;

  return (
    <>
      <div className="browser-toolbar">
        <button className="icon-btn" title="Back" onClick={() => api.request('view.back', {})}>
          <ArrowLeft size={16} />
        </button>
        <button className="icon-btn" title="Reload" onClick={() => api.request('view.reload', {})}>
          <RotateCw size={15} />
        </button>
        <button className="icon-btn" title="Go to the start URL (${URL}); random parameters get new values" onClick={goHome}>
          <Home size={15} />
        </button>
        <div className="urlbar" title={view.url}>
          <Globe size={13} />
          <span>{view.url || startUrl()}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Browser mode">
          <button className={view.mode === 'record' ? 'on record' : ''} onClick={() => setMode('record')} title="Record: clicking an element adds an event">
            <Circle size={10} fill={view.mode === 'record' ? '#ff6b6b' : 'none'} /> Record
          </button>
          <button className={view.mode === 'interact' ? 'on' : ''} onClick={() => setMode('interact')} title="Interact: use the page normally, nothing is recorded">
            <Hand size={13} /> Interact
          </button>
        </div>
      </div>
      <div className={`viewport${recording ? ' record' : ''}`}>
        {pickTarget && (
          <div className="pick-banner">
            <Crosshair size={14} /> {pickBanner(pickTarget)}
            <button className="icon-btn small" style={{ color: '#1a1a1a' }} onClick={() => useStore.setState({ pickTarget: null })}>
              <X size={13} />
            </button>
          </div>
        )}
        {robotPaused && (
          <div className="pause-banner">
            <span>Robot run paused{run.paused?.message ? `: ${run.paused.message}` : ''}</span>
            <button className="btn small primary" onClick={() => api.request('run.continue', {})}>
              <Play size={12} /> Continue
            </button>
          </div>
        )}
        {run.kind === 'live' && run.paused && (
          <div className="pause-banner">
            <span>Paused{run.paused.message ? `: ${run.paused.message}` : ''}</span>
            <button className="btn small primary" onClick={() => api.request('run.continue', {})}>
              <Play size={12} /> Continue
            </button>
          </div>
        )}
        <canvas
          ref={canvas}
          width={project?.settings.width ?? 1280}
          height={project?.settings.height ?? 800}
          tabIndex={0}
          style={{ visibility: view.status === 'ready' ? 'visible' : 'hidden' }}
          onMouseDown={(e) => {
            canvas.current?.focus();
            if (pickTarget && view.mode !== 'record') setMode('record');
            api.send('view.mouse', { type: 'down', ...toPage(e), button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1 });
          }}
          onMouseUp={(e) => api.send('view.mouse', { type: 'up', ...toPage(e), button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1 })}
          onMouseMove={(e) => {
            const now = performance.now();
            if (now - lastMove.current < 30) return;
            lastMove.current = now;
            api.send('view.mouse', { type: 'move', ...toPage(e) });
          }}
          onWheel={(e) => api.send('view.mouse', { type: 'wheel', ...toPage(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return; // let the app save
            e.preventDefault();
            e.stopPropagation();
            api.send('view.key', { type: 'down', key: e.key === ' ' ? 'Space' : e.key });
          }}
          onKeyUp={(e) => {
            e.preventDefault();
            api.send('view.key', { type: 'up', key: e.key === ' ' ? 'Space' : e.key });
          }}
          onPaste={(e) => api.send('view.key', { type: 'text', text: e.clipboardData.getData('text') })}
        />
        {view.status !== 'ready' && (
          <div className="overlay-msg">
            {view.status === 'starting' || view.status === 'idle' ? (
              <div>
                <Loader2 size={22} className="spin" />
                <div>Starting browser…</div>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 10 }}>{view.status === 'error' ? `Could not start the browser: ${view.message}` : 'The browser view was closed.'}</div>
                <button className="btn" onClick={() => void startView()}>
                  <RotateCw size={14} /> Restart browser view
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
