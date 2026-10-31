import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  Loader2,
  Menu as MenuIcon,
  PlayCircle,
  RefreshCw,
  Save,
  Settings,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Variable,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { ENVIRONMENTS, type Environment } from '@joule/core';
import { api } from './api';
import { Menu, MenuItem, Resizer } from './components/ui';
import { desktop, useUpdate } from './desktop';
import { FolderModal, NewProjectModal, StartModal } from './modals/ProjectModals';
import { ParamsModal, TestSettingsModal } from './modals/ParamsModal';
import { AppSettingsModal, SettingsModal } from './modals/SettingsModal';
import { BrowserPanel } from './panels/BrowserPanel';
import { DetailsPanel } from './panels/DetailsPanel';
import { StepsPanel } from './panels/StepsPanel';
import { TestsPanel } from './panels/TestsPanel';
import { call, edit, loadProject, openProject, redo, runRobot, save, toast, undo, useStore } from './store';

function usePersistedWidth(key: string, initial: number): [number, (dx: number) => void] {
  const [w, setW] = useState(() => {
    try {
      return Number(localStorage.getItem(key)) || initial;
    } catch {
      return initial;
    }
  });
  const resize = (dx: number) =>
    setW((prev) => {
      const next = Math.max(160, Math.min(720, prev + dx));
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  return [w, resize];
}

function TopBar() {
  const project = useStore((s) => s.project);
  const projectDir = useStore((s) => s.projectDir);
  const dirty = useStore((s) => s.dirty);
  const saving = useStore((s) => s.saving);
  const running = useStore((s) => s.run.running);
  const robotRunning = useStore((s) => s.run.running && s.run.kind === 'robot');
  const recent = useStore((s) => s.settings.recent);
  const open = (modal: ReturnType<typeof useStore.getState>['modal']) => useStore.setState({ modal });
  return (
    <div className="topbar">
      <Menu
        button={(toggle, isOpen) => (
          <button className={`icon-btn${isOpen ? ' active' : ''}`} onClick={toggle} title="Menu" aria-label="Menu">
            <MenuIcon size={18} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem icon={<FilePlus2 size={14} />} onClick={() => (close(), open({ kind: 'folder', purpose: 'new' }))}>
              New project
            </MenuItem>
            <MenuItem icon={<FolderOpen size={14} />} onClick={() => (close(), open({ kind: 'folder', purpose: 'open' }))}>
              Open project…
            </MenuItem>
            {recent.filter((d) => d !== projectDir).length > 0 && <div className="heading">Recent</div>}
            {recent
              .filter((d) => d !== projectDir)
              .slice(0, 5)
              .map((d) => (
                <MenuItem key={d} icon={<FolderOpen size={14} color="var(--muted)" />} onClick={() => (close(), void openProject(d))}>
                  {d.split(/[\\/]/).pop()}
                </MenuItem>
              ))}
            <div className="sep" />
            <MenuItem icon={<Save size={14} />} kbd="Ctrl+S" disabled={!project} onClick={() => (close(), void save())}>
              Save
            </MenuItem>
            <MenuItem icon={<Variable size={14} />} disabled={!project} onClick={() => (close(), open({ kind: 'params' }))}>
              Parameters
            </MenuItem>
            <MenuItem icon={<SlidersHorizontal size={14} />} disabled={!project} onClick={() => (close(), open({ kind: 'settings' }))}>
              Project settings
            </MenuItem>
            <MenuItem icon={<TerminalSquare size={14} />} disabled={!project} onClick={() => (close(), open({ kind: 'settings', tab: 'deps' }))}>
              Robot Framework setup
            </MenuItem>
            <div className="sep" />
            <MenuItem icon={<Settings size={14} />} onClick={() => (close(), open({ kind: 'app' }))}>
              App settings
            </MenuItem>
          </>
        )}
      </Menu>
      <div className="brand">
        <img src="/favicon.svg" width={20} height={20} alt="" />
        <span className="project-name" title={projectDir}>
          {project?.name ?? 'Joule'}
        </span>
      </div>
      {project && (
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
          {saving ? <Loader2 size={12} className="spin" /> : dirty ? <span className="status-dot" style={{ background: 'var(--warn)' }} /> : <Check size={12} />}
          {saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}
        </span>
      )}
      <span className="spacer" />
      {project && (
        <>
          <button className="btn small ghost" onClick={() => open({ kind: 'params' })} title="Project parameters">
            <Variable size={14} /> Parameters
          </button>
          <select
            className="select"
            style={{ width: 90, height: 28 }}
            title="Environment"
            value={project.settings.environment}
            onChange={(e) => edit((p) => ({ ...p, settings: { ...p.settings, environment: e.target.value as Environment } }))}
          >
            {ENVIRONMENTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
          <button className="icon-btn" title="Project settings" onClick={() => open({ kind: 'settings' })}>
            <SlidersHorizontal size={16} />
          </button>
          {robotRunning ? (
            <button className="btn small danger" onClick={() => api.request('run.stop', {})}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="btn small primary" disabled={running} onClick={() => runRobot({ headless: project.settings.headlessRunAll })} title="Run all tests with Robot Framework following the run plan">
              <PlayCircle size={14} /> Run all
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** One line of Robot output; memoized, so a batch of new lines doesn't re-render the old ones. */
const OutputLine = memo(function OutputLine({ line }: { line: string }) {
  return <div className={/\|\s*PASS\s*\|/.test(line) ? 'PASS' : /\|\s*FAIL\s*\|/.test(line) ? 'FAIL' : ''}>{line}</div>;
});

function OutputDrawer() {
  const run = useStore((s) => s.run);
  const open = useStore((s) => s.outputOpen);
  const project = useStore((s) => s.project);
  const ref = (el: HTMLDivElement | null) => el && (el.scrollTop = el.scrollHeight);
  if (!open) return null;
  const logUrl = run.logDir ? `/project-files/${run.logDir.replace(/\\/g, '/')}/log.html` : undefined;
  return (
    <div className="drawer">
      <div className="column-header">
        <span className="title">
          Robot Framework output {run.running && <Loader2 size={11} className="spin" />}
        </span>
        {run.results?.map((r) => (
          <span key={r.name} className={`badge ${r.status === 'PASS' ? 'ok' : r.status === 'FAIL' ? 'err' : ''}`} title={r.message}>
            {r.name}: {r.status}
          </span>
        ))}
        {logUrl && run.kind === 'robot' && !run.running && (
          <a className="btn small" href={logUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Open log
          </a>
        )}
        {!run.running && run.kind === 'robot' && project && (
          <button className="icon-btn" title="Run again" onClick={() => runRobot({ testIds: run.testIds.length === project.tests.length ? undefined : run.testIds })}>
            <RefreshCw size={14} />
          </button>
        )}
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ outputOpen: false })}>
          <X size={15} />
        </button>
      </div>
      <div className="console" ref={ref}>
        {run.kind !== 'robot' && <span className="muted">Run a test with Robot Framework to see its output here.</span>}
        {run.kind === 'robot' && run.output.map((l, i) => <OutputLine key={run.outputStart + i} line={l} />)}
      </div>
    </div>
  );
}

/** "New version available" in the status bar; updating is up to the user. */
function UpdateItem() {
  const update = useUpdate();
  const running = useStore((s) => s.run.running);
  if (!update) return null;
  const install = async () => {
    // Quitting with unsaved changes would be blocked (and lose them), so save first.
    await save();
    if (useStore.getState().dirty) return toast('Save your changes before updating', 'error');
    await desktop?.installUpdate();
  };
  if (update.status === 'downloading' || update.status === 'installing') {
    return (
      <span className="item" style={{ color: 'var(--accent)' }}>
        <Loader2 size={12} className="spin" />
        {update.status === 'downloading' ? `Downloading Joule ${update.version}… ${update.progress ?? 0}%` : 'Installing update…'}
      </span>
    );
  }
  return (
    <Menu
      align="right"
      up
      button={(toggle) => (
        <button onClick={toggle} style={{ color: update.status === 'error' ? 'var(--danger)' : 'var(--accent)' }} title={update.error}>
          {update.status === 'error' ? <AlertTriangle size={12} /> : <ArrowUpCircle size={12} />}
          {update.status === 'error' ? 'Update failed' : `Joule ${update.version} available`}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="heading">Joule {update.version}</div>
          {update.error && <div className="muted" style={{ padding: '2px 10px 6px', maxWidth: 280 }}>{update.error}</div>}
          {update.canInstall ? (
            <MenuItem icon={<Download size={14} />} disabled={running} onClick={() => (close(), void install())}>
              {running ? 'Update after the run finishes' : update.status === 'error' ? 'Try again' : 'Update and restart'}
            </MenuItem>
          ) : (
            <MenuItem icon={<Download size={14} />} onClick={() => (close(), window.open(update.notesUrl))}>
              Download from GitHub
            </MenuItem>
          )}
          <MenuItem icon={<ExternalLink size={14} />} onClick={() => (close(), window.open(update.notesUrl))}>
            Release notes
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function StatusBar() {
  const connected = useStore((s) => s.connected);
  // only in-app runs are shown here, so the lines of a Robot run don't re-render the status bar
  const run = useStore((s) => (s.run.kind === 'live' ? s.run : undefined));
  const view = useStore((s) => s.view);
  const project = useStore((s) => s.project);
  const outputOpen = useStore((s) => s.outputOpen);
  const steps = run ? Object.values(run.steps) : [];
  return (
    <div className="statusbar">
      <span className="item">{connected ? <Wifi size={12} color="var(--ok)" /> : <WifiOff size={12} color="var(--danger)" />}{connected ? 'Connected' : 'Reconnecting…'}</span>
      {project && (
        <span className="item">
          {project.settings.browser} · {project.settings.width}×{project.settings.height} · {project.settings.environment}
        </span>
      )}
      {view.mode === 'record' && <span className="item" style={{ color: '#ff7b7b' }}>● Recording</span>}
      {run && (
        <span className="item">
          {run.running ? <Loader2 size={12} className="spin" /> : run.ok ? <Check size={12} color="var(--ok)" /> : <AlertTriangle size={12} color="var(--danger)" />}
          In-app run: {steps.filter((s) => s.status === 'pass').length} passed, {steps.filter((s) => s.status === 'fail').length} failed
          {!run.running && run.logDir && <span className="muted"> · log saved to {run.logDir}</span>}
        </span>
      )}
      <span className="grow" />
      <UpdateItem />
      <button onClick={() => useStore.setState({ outputOpen: !outputOpen })}>
        <TerminalSquare size={12} /> Output
      </button>
    </div>
  );
}

function ExternalEditsBanner() {
  const edits = useStore((s) => s.externalEdits);
  if (!edits.length) return null;
  return (
    <div className="notice warn" style={{ margin: 0, borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
      <AlertTriangle size={14} />
      <span className="grow">
        {edits.join(', ')} {edits.length > 1 ? 'were' : 'was'} changed outside Joule. Saving now would overwrite those changes.
      </span>
      <button
        className="btn small"
        onClick={async () => {
          const r = await call(api.request('project.reimport', {}));
          if (r) {
            loadProject(useStore.getState().projectDir!, r.project, { warnings: r.warnings });
            useStore.setState({ dirty: true });
            await save();
          }
        }}
      >
        Load the changes
      </button>
      <button className="btn small ghost" onClick={() => useStore.setState({ externalEdits: [] })}>
        Keep Joule version
      </button>
    </div>
  );
}

function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'start':
      return <StartModal />;
    case 'folder':
      return <FolderModal purpose={modal.purpose} />;
    case 'new':
      return <NewProjectModal dir={modal.dir} />;
    case 'params':
      return <ParamsModal />;
    case 'settings':
      return <SettingsModal tab={modal.tab} />;
    case 'app':
      return <AppSettingsModal />;
    case 'test':
      return <TestSettingsModal testId={modal.testId} />;
  }
}

export function App() {
  const hasProject = useStore((s) => !!s.project);
  const detail = useStore((s) => s.detail);
  const toastMsg = useStore((s) => s.toast);
  const warnings = useStore((s) => s.warnings);
  const [testsW, resizeTests] = usePersistedWidth('w.tests', 230);
  const [stepsW, resizeSteps] = usePersistedWidth('w.steps', 360);
  const [detailsW, resizeDetails] = usePersistedWidth('w.details', 360);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (mod && !inField && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && !inField && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      <ExternalEditsBanner />
      {warnings.length > 0 && (
        <div className="notice warn" style={{ margin: 0, borderRadius: 0 }}>
          <AlertTriangle size={14} />
          <details className="grow">
            <summary>{warnings.length} note(s) from opening the Robot files</summary>
            {warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </details>
          <button className="icon-btn small" onClick={() => useStore.setState({ warnings: [] })}>
            <X size={13} />
          </button>
        </div>
      )}
      {hasProject ? (
        <div className="columns">
          <div className="column side" style={{ width: testsW, flexShrink: 0 }}>
            <TestsPanel />
          </div>
          <Resizer onResize={resizeTests} />
          <div className="column side" style={{ width: stepsW, flexShrink: 0 }}>
            <StepsPanel />
          </div>
          <Resizer onResize={resizeSteps} />
          <div className="column" style={{ flex: 1 }}>
            <BrowserPanel />
          </div>
          {detail && (
            <>
              <Resizer onResize={(dx) => resizeDetails(-dx)} />
              <div className="column side" style={{ width: detailsW, flexShrink: 0 }}>
                <DetailsPanel />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="columns" style={{ display: 'grid', placeItems: 'center' }}>
          <button className="btn" onClick={() => useStore.setState({ modal: { kind: 'start' } })}>
            <ChevronDown size={14} /> Open or create a project
          </button>
        </div>
      )}
      <OutputDrawer />
      <StatusBar />
      <Modals />
      {toastMsg && <div className={`toast ${toastMsg.kind}`}>{toastMsg.text}</div>}
    </div>
  );
}
