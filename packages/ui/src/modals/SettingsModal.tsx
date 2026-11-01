import { AlertTriangle, ArrowDown, ArrowUpCircle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, Settings, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BROWSER_PKG, BROWSERS, effectiveRunPlan, ENVIRONMENTS, ROBOT_PKG, type DepsInfo, type Requests, type Settings as ProjectSettings } from '@joule/core';
import { api } from '../api';
import { Modal, NumberField, TextField } from '../components/ui';
import { desktop, installUpdate, useUpdate } from '../desktop';
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
                const id = e.dataTransfer.getData('text/joule-test');
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
                  <span key={id} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/joule-test', id)}>
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
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [versions, setVersions] = useState<{ robot: string[]; browser: string[] }>({ robot: [], browser: [] });
  const [robotPin, setRobotPin] = useState('');
  const [browserPin, setBrowserPin] = useState('');
  const browser = useStore((s) => s.project?.settings.browser);
  const check = async () => {
    setDeps(null);
    const d = (await call(api.request('deps.check', {}))) ?? null;
    setDeps(d);
    setRobotPin(d?.env.pins[ROBOT_PKG] ?? '');
    setBrowserPin(d?.env.pins[BROWSER_PKG] ?? '');
  };
  useEffect(() => {
    void check();
    void call(api.request('deps.versions', {})).then((v) => v && setVersions(v));
    return api.on('deps.output', ({ line }) => setLog((l) => [...l.slice(-300), line]));
  }, []);
  const install = async (payload: Requests['deps.install'][0]) => {
    setBusy(true);
    setLog([]);
    await call(api.request('deps.install', payload));
    setBusy(false);
    await check();
  };
  const Row = ({ ok, label, value, optional }: { ok: boolean; label: string; value?: string; optional?: boolean }) => (
    <div className="row" style={{ marginBottom: 6 }}>
      <span style={{ display: 'flex', flexShrink: 0 }}>
        {ok ? <CheckCircle2 size={15} color="var(--ok)" /> : optional ? <AlertTriangle size={15} color="var(--warn)" /> : <XCircle size={15} color="var(--danger)" />}
      </span>
      <span style={{ width: 210, flexShrink: 0 }}>{label}</span>
      <span className="mono muted">{value ?? 'not found'}</span>
    </div>
  );
  if (!deps)
    return (
      <div className="empty">
        <Loader2 className="spin" size={20} />
      </div>
    );
  const { env, playwright } = deps;
  // Edge is the installed one; Chromium and Firefox are builds that belong to the Browser library's Playwright
  const needed = browser === 'msedge' ? undefined : playwright?.browsers.find((b) => b.name === browser);
  const browserReady = deps.browserInit && (browser === 'msedge' || !!needed?.installed);
  const playwrightValue = playwright
    ? [
        playwright.version,
        ...playwright.browsers.map((b) => `${b.name === 'chromium' ? 'Chromium' : 'Firefox'} ${b.version}${b.installed ? '' : ' (not downloaded)'}`),
        ...(browser === 'msedge' ? ['Edge: installed one'] : []),
      ].join(' · ')
    : undefined;
  const envValue = !env.pyproject
    ? 'no pyproject.toml yet'
    : !env.lock
      ? 'no uv.lock yet'
      : env.synced === undefined
        ? 'uv.lock present (uv needed to compare)'
        : env.synced
          ? '.venv matches uv.lock'
          : '.venv or uv.lock is out of date with pyproject.toml';
  const inSync = env.lock && env.synced === true;
  // a version typed in that differs from the pin; an empty field leaves the pin as it is
  const newPin = (typed: string, pkg: string) => (typed.trim() && typed.trim() !== env.pins[pkg] ? typed.trim() : undefined);
  const pins = { robot: newPin(robotPin, ROBOT_PKG), browser: newPin(browserPin, BROWSER_PKG) };
  return (
    <>
      <Row ok={!!deps.uv} label="uv" value={deps.uv ? `${deps.uv.version} (${deps.uv.path})` : 'not found: installed with the button below'} />
      <Row ok={!!deps.python} label="Python 3" value={deps.python ? `${deps.python.version} (${deps.python.path})` : undefined} />
      <Row ok={!!deps.robot} label="Robot Framework" value={deps.robot} />
      <Row
        ok={!!deps.browser && (!deps.batteries || deps.batteries === deps.browser)}
        label="Browser library"
        value={deps.browser && (deps.batteries ? `${deps.browser} (batteries ${deps.batteries})` : deps.browser)}
      />
      <Row ok={browserReady} label="Playwright · browsers" value={playwrightValue} />
      <Row ok={!!deps.pabot} optional label="pabot (parallel runs)" value={deps.pabot ?? 'optional'} />
      <Row ok={!!inSync} optional={env.lock} label="Locked versions" value={envValue} />

      <div className="field" style={{ marginTop: 14 }}>
        <label>Versions for this project (pyproject.toml)</label>
        <div className="row">
          <span className="muted">Robot Framework</span>
          <input className="input mono" style={{ width: 110 }} list="robot-versions" placeholder="version" value={robotPin} onChange={(e) => setRobotPin(e.target.value)} />
          <span className="muted" style={{ marginLeft: 8 }}>Browser library</span>
          <input className="input mono" style={{ width: 110 }} list="browser-versions" placeholder="version" value={browserPin} onChange={(e) => setBrowserPin(e.target.value)} />
          <button
            className="btn"
            disabled={busy || !(pins.robot || pins.browser)}
            onClick={() => void install({ pins })}
          >
            Apply
          </button>
          <button className="btn" disabled={busy} onClick={() => void install({ upgrade: true })}>
            <ArrowUpCircle size={13} /> Update all to latest
          </button>
        </div>
        <datalist id="robot-versions">
          {versions.robot.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <datalist id="browser-versions">
          {versions.browser.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          The Browser library version decides the Playwright version and the Chromium / Firefox builds the tests run in; its batteries get
          the same version. uv.lock pins every package exactly, so setup.bat / setup.sh install the same versions anywhere (CI).
        </p>
      </div>

      {(!deps.ok || !inSync) && (
        <>
          <div className="notice warn" style={{ marginTop: 12 }}>
            Install the locked versions into a .venv in the project folder with the button, or run these commands yourself:
          </div>
          <pre className="cmds">{deps.installCommands.join('\n')}</pre>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy} onClick={() => void check()}>
          <RefreshCw size={13} /> Check again
        </button>
        <button className={`btn${deps.ok && inSync && browserReady ? '' : ' primary'}`} disabled={busy} onClick={() => void install({})}>
          {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {env.lock ? 'Sync .venv with uv.lock' : 'Install into .venv'}
        </button>
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

/** Version and updates of the desktop app; hidden in the browser and VS Code. */
function VersionField() {
  const update = useUpdate();
  const running = useStore((s) => s.run.running);
  if (!update) return null;
  const a = update.available;
  const busy = a?.status === 'downloading' || a?.status === 'installing';
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [icon, text] = update.checking
    ? [<Loader2 size={15} className="spin" />, 'Checking for updates…']
    : a?.status === 'downloading'
      ? [<Loader2 size={15} className="spin" />, `Downloading Joule ${a.version}… ${a.progress ?? 0}%`]
      : a?.status === 'installing'
        ? [<Loader2 size={15} className="spin" />, 'Installing, Joule restarts in a moment…']
        : a?.status === 'error'
          ? [<XCircle size={15} color="var(--danger)" />, `Updating to ${a.version} failed: ${a.error}`]
          : a
            ? [<ArrowUpCircle size={15} color="var(--accent)" />, `Joule ${a.version} is available`]
            : update.checkError
              ? [<AlertTriangle size={15} color="var(--warn)" />, `Couldn't check for updates: ${update.checkError}`]
              : update.checkedAt
                ? [<CheckCircle2 size={15} color="var(--ok)" />, `Joule is up to date (checked at ${time(update.checkedAt)})`]
                : [undefined, 'Not checked for updates yet'];
  return (
    <div className="field">
      <label>Version</label>
      <div className="row">
        <span className="mono grow">Joule {update.current}</span>
        <button className="btn" disabled={update.checking || busy} onClick={() => void desktop?.checkForUpdates()}>
          <RefreshCw size={13} /> Check for updates
        </button>
      </div>
      <div className="row">
        {icon && <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>}
        <span className="grow">{text}</span>
        {a && !busy && (
          <>
            <a className="btn" href={a.notesUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> Release notes
            </a>
            {a.blocked ? (
              <a className="btn primary" href={a.notesUrl} target="_blank" rel="noreferrer">
                <Download size={13} /> Download
              </a>
            ) : (
              <button className="btn primary" disabled={running} onClick={() => void installUpdate()}>
                <Download size={13} /> {a.status === 'error' ? 'Try again' : 'Update and restart'}
              </button>
            )}
          </>
        )}
      </div>
      {a && !busy && (a.blocked || running) && (
        <p className="muted" style={{ margin: 0 }}>
          {a.blocked ?? 'Updating is possible once the run finishes.'}
        </p>
      )}
    </div>
  );
}

export function AppSettingsModal() {
  const settings = useStore((s) => s.settings);
  const [python, setPython] = useState(settings.pythonPath ?? '');
  const [uv, setUv] = useState(settings.uvPath ?? '');
  const apply = async (next: typeof settings) => {
    const r = await call(api.request('app.saveSettings', { settings: next }));
    if (r) useStore.setState({ settings: r });
  };
  return (
    <Modal title="App settings" onClose={() => useStore.setState({ modal: null })}>
      <div className="modal-body">
        <VersionField />
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
          <label>uv (optional)</label>
          <div className="row">
            <input className="input mono" value={uv} placeholder="Auto: uv on PATH, then ~/.local/bin" onChange={(e) => setUv(e.target.value)} />
            <button className="btn" onClick={() => void apply({ ...settings, uvPath: uv || undefined })}>
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
        <p className="muted">Settings are stored in ~/.joule/settings.json. Project settings live in joule.json inside each project folder.</p>
      </div>
    </Modal>
  );
}

