import {
  BookOpen,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Clock,
  Code2,
  Copy,
  FolderPlus,
  GitBranch,
  Loader2,
  MinusCircle,
  MousePointerClick,
  Pause,
  Play,
  PlayCircle,
  Plus,
  Puzzle,
  Redo2,
  Square,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { describeStep, findStep, newId, numberSteps, positionOf, type Step } from '@joule/core';
import { api } from '../api';
import { Menu, MenuItem } from '../components/ui';
import { TypeIcon } from '../stepMeta';
import {
  addCustomCall,
  addStepOfType,
  addSteps,
  clearSelection,
  containerSteps,
  copySelected,
  deleteSelected,
  effectiveSelection,
  flatIds,
  groupSelected,
  moveSelected,
  paste,
  redo,
  runLive,
  selectStep,
  undo,
  updateCurrentStep,
  useStore,
  type StepRunState,
} from '../store';

type Row =
  | { kind: 'step'; step: Step; depth: number }
  | { kind: 'branch'; owner: string; branch: 'then' | 'else'; depth: number };

function rowsOf(steps: Step[], depth = 0): Row[] {
  const out: Row[] = [];
  for (const step of steps) {
    out.push({ kind: 'step', step, depth });
    if (step.type === 'group' && !step.collapsed) out.push(...rowsOf(step.steps, depth + 1));
    if (step.type === 'if') {
      out.push({ kind: 'branch', owner: step.id, branch: 'then', depth: depth + 1 }, ...rowsOf(step.then, depth + 2));
      out.push({ kind: 'branch', owner: step.id, branch: 'else', depth: depth + 1 }, ...rowsOf(step.else, depth + 2));
    }
  }
  return out;
}

function RunIcon({ state }: { state?: StepRunState }) {
  if (!state) return null;
  const title = state.message ?? state.status;
  if (state.status === 'running') return <Loader2 size={14} className="spin" color="var(--accent)" />;
  if (state.status === 'pass') return <CheckCircle2 size={14} color="var(--ok)" aria-label={title} />;
  if (state.status === 'fail') return <XCircle size={14} color="var(--danger)" aria-label={title} />;
  return <MinusCircle size={14} color="var(--muted)" aria-label={title} />;
}

type DropPos = 'before' | 'after' | 'inside';
const INDENT = 18;

export function StepsPanel() {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const selected = useStore((s) => s.selected);
  const detail = useStore((s) => s.detail);
  const run = useStore((s) => s.run);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const customKeywords = useStore((s) => s.customKeywords);
  const [drop, setDrop] = useState<{ key: string; pos: DropPos } | null>(null);

  const steps = containerSteps(project, current);
  const rows = useMemo(() => rowsOf(steps), [steps]);
  const numbers = useMemo(() => numberSteps(steps), [steps]);
  const effective = useMemo(() => effectiveSelection(steps, selected), [steps, selected]);
  const container = current?.kind === 'keyword' ? project?.keywords.find((k) => k.id === current.id) : project?.tests.find((t) => t.id === current?.id);
  if (!project || !current || !container) return null;

  const dragIds = (id: string) => (selected.includes(id) ? selected : [id]);

  function dropTarget(row: Row, pos: DropPos): { target: string; index: number } | undefined {
    if (row.kind === 'branch') return { target: `${row.owner}:${row.branch}`, index: 0 };
    const s = row.step;
    if (pos === 'inside') {
      if (s.type === 'group') return { target: s.id, index: s.steps.length };
      if (s.type === 'if') return { target: `${s.id}:then`, index: s.then.length };
    }
    const p = positionOf(steps, s.id);
    if (!p) return undefined;
    return { target: p.target, index: pos === 'after' ? p.index + 1 : p.index };
  }

  function onDragOver(e: DragEvent, row: Row, key: string) {
    if (!e.dataTransfer.types.includes('application/x-joule-steps')) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const container = row.kind === 'step' && (row.step.type === 'group' || row.step.type === 'if');
    const pos: DropPos = row.kind === 'branch' ? 'inside' : container ? (y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside') : y < 0.5 ? 'before' : 'after';
    if (drop?.key !== key || drop.pos !== pos) setDrop({ key, pos });
  }

  function onDrop(e: DragEvent, row: Row) {
    e.preventDefault();
    const ids = JSON.parse(e.dataTransfer.getData('application/x-joule-steps') || '[]') as string[];
    const t = drop && dropTarget(row, drop.pos);
    setDrop(null);
    if (t && ids.length) moveSelected(ids, t.target, t.index);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
    } else if (mod && e.key.toLowerCase() === 'c') void copySelected();
    else if (mod && e.key.toLowerCase() === 'v') void paste();
    else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      groupSelected();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      useStore.setState({ selected: flatIds(steps) });
    } else if (e.key === 'Escape') clearSelection();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = flatIds(steps);
      const i = detail ? ids.indexOf(detail) : -1;
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) selectStep(next, { shift: e.shiftKey });
    }
  }

  const live = run.kind === 'live' && run.running;
  const hasSelection = selected.length > 0;
  const dimOthers = hasSelection;

  const rendered: ReactNode[] = [];
  rows.forEach((row, i) => {
    const key = row.kind === 'step' ? row.step.id : `${row.owner}:${row.branch}`;
    const dropClass = drop?.key === key ? ` drop-${drop.pos}` : '';
    const guides = Array.from({ length: row.depth }, (_, d) => <span key={d} className="indent-guide" style={{ left: 18 + d * INDENT }} />);
    if (row.kind === 'branch') {
      rendered.push(
        <div
          key={key}
          className={`step-row branch${dropClass}`}
          style={{ paddingLeft: 12 + row.depth * INDENT }}
          onDragOver={(e) => onDragOver(e, row, key)}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => onDrop(e, row)}
        >
          {guides}
          {row.branch === 'then' ? 'Then' : 'Else'}
          <button
            className="icon-btn small"
            title={`Add a step to ${row.branch}`}
            onClick={() => {
              useStore.setState({ detail: undefined });
              const wait: Step = { id: newId('s'), name: '', type: 'wait', wait: { kind: 'time', seconds: 1 } };
              moveAfterInsert(row.owner, row.branch, wait);
            }}
          >
            <Plus size={12} />
          </button>
        </div>,
      );
      return;
    }
    const s = row.step;
    const state = run.steps[s.id];
    const num = numbers.get(s.id);
    rendered.push(
      <div
        key={key}
        className={`step-row${s.type === 'group' ? ' group-row' : ''}${effective.has(s.id) ? ' selected' : ''}${detail === s.id ? ' detail' : ''}${dimOthers && !effective.has(s.id) ? ' dim' : ''}${dropClass}`}
        style={{ paddingLeft: 8 + row.depth * INDENT }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-joule-steps', JSON.stringify(dragIds(s.id)));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => onDragOver(e, row, key)}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => onDrop(e, row)}
        onDragEnd={() => setDrop(null)}
        onClick={(e) => selectStep(s.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
        title={state?.message}
      >
        {guides}
        <span className="chev">
          {s.type === 'group' ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                updateCurrentStep(s.id, (x) => (x.type === 'group' ? { ...x, collapsed: !x.collapsed } : x));
              }}
            >
              {s.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
          ) : null}
        </span>
        {s.type !== 'group' && <span className="num">{num}</span>}
        <TypeIcon step={s} />
        <span className="step-label">{describeStep(s, project.keywords)}</span>
        {s.type === 'group' && <span className="badge">{s.steps.length} steps</span>}
        <span className="run-state">
          <RunIcon state={state} />
        </span>
      </div>,
    );
    if (state?.status === 'fail' && state.message && state.message !== 'A nested step failed') {
      rendered.push(
        <div key={`${key}-err`} className="step-error" style={{ paddingLeft: 50 + row.depth * INDENT }}>
          {state.message}
        </div>,
      );
    }
    void i;
  });

  return (
    <>
      <div className="column-header">
        <span className="title" title={container.name}>
          {current.kind === 'keyword' ? 'Keyword · ' : ''}
          {container.name}
        </span>
        {run.paused && run.kind === 'live' && (
          <button className="btn small primary" onClick={() => api.request('run.continue', {})} title="Continue after pause">
            <Play size={12} /> Continue
          </button>
        )}
        {live ? (
          <button className="icon-btn" title="Stop run" onClick={() => api.request('run.stop', {})}>
            <Square size={15} color="var(--danger)" />
          </button>
        ) : (
          <>
            <button className="icon-btn" title={hasSelection ? 'Run selected steps in the browser view' : 'Select steps to run only those'} disabled={!hasSelection || run.running} onClick={() => runLive({ stepIds: selected, fromStart: false })}>
              <Play size={15} />
            </button>
            <button className="icon-btn" title="Run all steps in the browser view (from the start URL)" disabled={run.running || !steps.length} onClick={() => runLive({ fromStart: true })}>
              <PlayCircle size={16} />
            </button>
          </>
        )}
      </div>
      <div className="steps-toolbar">
        <Menu
          button={(toggle) => (
            <button className="btn small" onClick={toggle}>
              <Plus size={13} /> Add
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="heading">Page independent</div>
              <MenuItem icon={<Clock size={14} color="#fbbf24" />} onClick={() => (close(), addStepOfType('wait'))}>
                Wait (time, page load, element)
              </MenuItem>
              <MenuItem icon={<Pause size={14} color="#fb923c" />} onClick={() => (close(), addStepOfType('pause'))}>
                Pause
              </MenuItem>
              <MenuItem icon={<Camera size={14} color="#f472b6" />} onClick={() => (close(), addStepOfType('screenshot'))}>
                Screenshot
              </MenuItem>
              <MenuItem icon={<GitBranch size={14} color="#facc15" />} onClick={() => (close(), addStepOfType('if'))}>
                If statement
              </MenuItem>
              <MenuItem icon={<FolderPlus size={14} color="#a1a1aa" />} onClick={() => (close(), addStepOfType('group'))}>
                Empty group
              </MenuItem>
              <MenuItem
                icon={<Code2 size={14} color="#94a3b8" />}
                onClick={() => {
                  close();
                  addSteps([{ id: newId('s'), name: '', type: 'raw', lines: ['Log    Hello from Robot Framework'] }]);
                }}
              >
                Robot Framework code
              </MenuItem>
              <div className="sep" />
              <div className="heading">Reusable keywords</div>
              {project.keywords.length === 0 && <div className="muted" style={{ padding: '4px 10px', fontSize: 12 }}>None yet</div>}
              {project.keywords
                .filter((k) => !(current.kind === 'keyword' && k.id === current.id))
                .map((k) => (
                  <MenuItem key={k.id} icon={<Puzzle size={14} color="#a78bfa" />} onClick={() => (close(), addStepOfType('keywordCall', { keywordId: k.id }))}>
                    {k.name}
                  </MenuItem>
                ))}
              {customKeywords.length > 0 && <div className="heading">Custom keywords</div>}
              {customKeywords.map((k) => (
                <MenuItem key={`${k.source}#${k.name}`} icon={<BookOpen size={14} color="#38bdf8" />} onClick={() => (close(), addCustomCall(k))}>
                  {k.name}
                  {customKeywords.some((o) => o !== k && o.name.toLowerCase() === k.name.toLowerCase()) && <span className="muted"> · {k.source.split('/').pop()}</span>}
                </MenuItem>
              ))}
              <div className="sep" />
              <div className="muted" style={{ padding: '4px 10px 6px', fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                <MousePointerClick size={13} /> Element events: use Record mode in the browser view
              </div>
            </>
          )}
        </Menu>
        <button className="icon-btn small" title="Group selected (Ctrl+G)" disabled={!hasSelection} onClick={groupSelected}>
          <FolderPlus size={14} />
        </button>
        <button className="icon-btn small" title="Copy (Ctrl+C)" disabled={!hasSelection} onClick={() => void copySelected()}>
          <Copy size={14} />
        </button>
        <button className="icon-btn small" title="Paste (Ctrl+V)" onClick={() => void paste()}>
          <ClipboardPaste size={14} />
        </button>
        <button className="icon-btn small" title="Delete (Del)" disabled={!hasSelection} onClick={deleteSelected}>
          <Trash2 size={14} />
        </button>
        <span className="grow" />
        <button className="icon-btn small" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button className="icon-btn small" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={14} />
        </button>
      </div>
      <div
        className="column-body"
        tabIndex={0}
        style={{ outline: 'none', paddingBottom: 40 }}
        onKeyDown={onKeyDown}
        onClick={(e) => e.target === e.currentTarget && clearSelection()}
        onDragOver={(e) => e.dataTransfer.types.includes('application/x-joule-steps') && e.preventDefault()}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          const ids = JSON.parse(e.dataTransfer.getData('application/x-joule-steps') || '[]') as string[];
          if (ids.length) moveSelected(ids, 'root', steps.length);
        }}
      >
        {steps.length === 0 ? (
          <div className="empty">
            <Circle size={28} />
            <div>No events defined yet.</div>
            <div className="hint">
              Switch the browser view to <b>Record</b> and click on an element, or use <b>Add</b> for waits, pauses, screenshots and if statements.
            </div>
          </div>
        ) : (
          rendered
        )}
      </div>
    </>
  );
}

/** Add a step at the end of an if branch. */
function moveAfterInsert(ifId: string, branch: 'then' | 'else', step: Step) {
  const { project, current } = useStore.getState();
  const s = findStep(containerSteps(project, current), ifId);
  if (!s || s.type !== 'if') return;
  updateCurrentStep(ifId, (x) => (x.type === 'if' ? { ...x, [branch]: [...x[branch], step] } : x));
  useStore.setState({ selected: [step.id], detail: step.id, anchor: step.id });
}
