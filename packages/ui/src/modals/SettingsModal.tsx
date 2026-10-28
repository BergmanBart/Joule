import { ArrowDown, CheckCircle2, Download, Loader2, RefreshCw, Settings, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BROWSERS, effectiveRunPlan, ENVIRONMENTS, type DepsInfo, type Settings as ProjectSettings } from '@uitester/core';
import { api } from '../api';
import { Modal, NumberField, TextField } from '../components/ui';
import { call, edit, save, startView, useStore } from '../store';

const RESOLUTIONS = [
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [390, 844],
  [768, 1024],
];

const BROWSER_NAMES: Record<string, string> = { chromium: 'Chrome / Chromium', msedge: 'Microsoft Edge', firefox: 'Firefox' };

function setSettings(patch: Partial<ProjectSettings>) {
  edit((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
}

function General() {
  const s = useStore((st) => st.project!.settings);
  const restartView = (patch: Partial<ProjectSettings>) => {
    setSettings(patch);
    setTimeout(() => void startView(), 50);
  };
  return (
    <>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="field grow">
          <label>Browser</label>
          <select className="select" value={s.browser} onChange={(e) => restartView({ browser: e.target.value as ProjectSettings['browser'] })}>
            {BROWSERS.map((b) => (
              <option key={b} value={b}>
                {BROWSER_NAMES[b]}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label>Environment</label>
          <select className="select" value={s.environment} onChange={(e) => setSettings({ environment: e.target.value as ProjectSettings['environment'] })}>
            {ENVIRONMENTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Screen resolution</label>
        <div className="row">
          <select
            className="select"
            style={{ width: 160 }}
            value={RESOLUTIONS.some(([w, h]) => w === s.width && h === s.height) ? `${s.width}x${s.height}` : 'custom'}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              if (w && h) restartView({ width: w, height: h });
            }}
          >
            {RESOLUTIONS.map(([w, h]) => (
              <option key={`${w}x${h}`} value={`${w}x${h}`}>
                {w} × {h}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <NumberField value={s.width} min={200} onCommit={(width) => restartView({ width })} />
          <span className="muted">×</span>
          <NumberField value={s.height} min={200} onCommit={(height) => restartView({ height })} />
        </div>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <div className="field grow">
          <label>Timeout (seconds)</label>
          <NumberField value={s.timeoutSeconds} min={1} onCommit={(timeoutSeconds) => setSettings({ timeoutSeconds })} />
        </div>
        <div className="field grow">
          <label>Retries for failed tests</label>
          <NumberField value={s.retries} min={0} onCommit={(retries) => setSettings({ retries: Math.round(retries) })} />
        </div>
      </div>
      <div className="field">
        <label>Running</label>
        <label className="check">
          <input type="checkbox" checked={s.headless} onChange={(e) => setSettings({ headless: e.target.checked })} /> Headless when running a single test with Robot Framework
        </label>
        <label className="check">
          <input type="checkbox" checked={s.headlessRunAll} onChange={(e) => setSettings({ headlessRunAll: e.target.checked })} /> Run all tests without opening a browser (in the background)
        </label>
      </div>
      <div className="field">
        <label>Screenshot folder (relative to the project folder)</label>
        <TextField value={s.screenshotDir} mono onCommit={(screenshotDir) => setSettings({ screenshotDir: screenshotDir || 'screenshots' })} />
      </div>
    </>
  );
}

/** Stages run one after another; the tests inside a stage run in parallel. */
function RunPlan() {
  const project = useStore((s) => s.project)!;
  const [over, setOver] = useState<number | null>(null);
  const stages = effectiveRunPlan(project);
  const name = (id: string) => project.tests.find((t) => t.id === id)?.name ?? id;
  const setStages = (next: string[][]) => setSettings({ runPlan: next.filter((s) => s.length).map((tests) => ({ tests })) });
  const moveTo = (testId: string, stage: number) => {
    const next = stages.map((s) => s.filter((t) => t !== testId));
    if (stage >= next.length) next.push([testId]);
    else next[stage].push(testId);
    setStages(next);
  };
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Stages run in series, top to bottom. Tests in the same stage run in parallel (with pabot). Drag tests between stages.
      </p>
      <div className="lanes">
        {[...stages, []].map((stage, i) => (
          <div key={i}>
            {i > 0 && (
              <div className="lane-arrow">
                <ArrowDown size={12} />
              </div>
            )}
            <div
              className={`lane${over === i ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                const id = e.dataTransfer.getData('text/uitester-test');
                if (id) moveTo(id, i);
              }}
            >
              <div className="lane-head">
                <span>{i < stages.length ? `Stage ${i + 1}` : 'Drop here for a new stage'}</span>
                {stage.length > 1 && <span className="badge accent">parallel × {stage.length}</span>}
                {stage.length === 1 && <span className="badge">series</span>}
              </div>
              <div className="lane-chips">
                {stage.map((id) => (
                  <span key={id} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/uitester-test', id)}>
                    {name(id)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn small" onClick={() => setStages([project.tests.map((t) => t.id)])}>
          All in parallel
        </button>
        <button className="btn small" onClick={() => setStages(project.tests.map((t) => [t.id]))}>
          All in series
        </button>
      </div>
    </>
  );
}

function Deps() {
  const [deps, setDeps] = useState<DepsInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const browser = useStore((s) => s.project?.settings.browser);
  const check = async () => {
    setDeps(null);
    setDeps((await call(api.request('deps.check', {}))) ?? null);
  };
  useEffect(() => {
    void check();
    return api.on('deps.output', ({ line }) => setLog((l) => [...l.slice(-300), line]));
  }, []);
  const Row = ({ ok, label, value }: { ok: boolean; label: string; value?: string }) => (
    <div className="row" style={{ marginBottom: 6 }}>
      {ok ? <CheckCircle2 size={15} color="var(--ok)" /> : <XCircle size={15} color="var(--danger)" />}
      <span style={{ width: 210 }}>{label}</span>
      <span className="mono muted">{value ?? 'not found'}</span>
    </div>
  );
  if (!deps)
    return (
      <div className="empty">
        <Loader2 className="spin" size={20} />
      </div>
    );
  return (
    <>
      <Row ok={!!deps.python} label="Python 3" value={deps.python ? `${deps.python.version} (${deps.python.path})` : undefined} />
      <Row ok={!!deps.robot} label="Robot Framework" value={deps.robot} />
      <Row ok={!!deps.browser} label="Browser library" value={deps.browser} />
      <Row ok={deps.browserInit} label="rfbrowser init" value={deps.browserInit ? 'done' : undefined} />
      <Row ok={!!deps.pabot} label="pabot (parallel runs)" value={deps.pabot ?? 'optional'} />
      {!deps.ok && (
        <>
          <div className="notice warn" style={{ marginTop: 12 }}>
            Running .robot files needs the packages above. Install them in a virtual environment in the project folder, or run these commands yourself:
          </div>
          <pre className="cmds">{deps.installCommands.join('\n')}</pre>
        </>
      )}
      <div className="row">
        <button className="btn" onClick={() => void check()}>
          <RefreshCw size={13} /> Check again
        </button>
        {!deps.ok && (
          <button
            className="btn primary"
            disabled={installing || !deps.python}
            onClick={async () => {
              setInstalling(true);
              setLog([]);
              await call(api.request('deps.install', { skipBrowsers: browser === 'msedge' }));
              setInstalling(false);
              await check();
            }}
          >
            {installing ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Install into .venv
          </button>
        )}
      </div>
      {log.length > 0 && <pre className="cmds" style={{ marginTop: 12, maxHeight: 200, overflow: 'auto' }}>{log.join('\n')}</pre>}
    </>
  );
}

export function SettingsModal({ tab = 'general' }: { tab?: 'general' | 'runplan' | 'deps' }) {
  const [t, setT] = useState(tab);
  return (
    <Modal
      title="Project settings"
      wide
      icon={<Settings size={18} color="var(--accent)" />}
      onClose={() => {
        useStore.setState({ modal: null });
        void save();
      }}
    >
      <div className="tabs">
        <button className={t === 'general' ? 'on' : ''} onClick={() => setT('general')}>
          General
        </button>
        <button className={t === 'runplan' ? 'on' : ''} onClick={() => setT('runplan')}>
          Run plan
        </button>
        <button className={t === 'deps' ? 'on' : ''} onClick={() => setT('deps')}>
          Robot Framework
        </button>
      </div>
      <div className="modal-body" style={{ minHeight: 360 }}>
        {t === 'general' && <General />}
        {t === 'runplan' && <RunPlan />}
        {t === 'deps' && <Deps />}
      </div>
    </Modal>
  );
}

export function AppSettingsModal() {
  const settings = useStore((s) => s.settings);
  const [python, setPython] = useState(settings.pythonPath ?? '');
  const apply = async (next: typeof settings) => {
    const r = await call(api.request('app.saveSettings', { settings: next }));
    if (r) useStore.setState({ settings: r });
  };
  return (
    <Modal title="App settings" onClose={() => useStore.setState({ modal: null })}>
      <div className="modal-body">
        <div className="field">
          <label>Python interpreter (optional)</label>
          <div className="row">
            <input className="input mono" value={python} placeholder="Auto: .venv in the project, then python on PATH" onChange={(e) => setPython(e.target.value)} />
            <button className="btn" onClick={() => void apply({ ...settings, pythonPath: python || undefined })}>
              Save
            </button>
          </div>
        </div>
        <div className="field">
          <label>Recent projects</label>
          {settings.recent.length === 0 && <span className="muted">None</span>}
          {settings.recent.map((d) => (
            <div key={d} className="row">
              <span className="mono grow">{d}</span>
              <button className="icon-btn small" onClick={() => void apply({ ...settings, recent: settings.recent.filter((x) => x !== d) })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <p className="muted">Settings are stored in ~/.uitester/settings.json. Project settings live in uitester.json inside each project folder.</p>
      </div>
    </Modal>
  );
}

