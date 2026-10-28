import { ArrowUp, Folder, FolderOpen, FolderPlus, HardDrive, Plus, TestTube2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FsEntry } from '@uitester/core';
import { api } from '../api';
import { Modal } from '../components/ui';
import { call, loadProject, openProject, toast, useStore } from '../store';

export function StartModal() {
  const settings = useStore((s) => s.settings);
  const hasProject = useStore((s) => !!s.project);
  const close = hasProject ? () => useStore.setState({ modal: null }) : undefined;
  return (
    <Modal title="Welcome to UITester" onClose={close} icon={<TestTube2 size={18} color="var(--accent)" />}>
      <div className="modal-body start">
        <button className="big" onClick={() => useStore.setState({ modal: { kind: 'folder', purpose: 'new' } })}>
          <Plus size={22} color="var(--accent)" />
          <div>
            <div className="t">New project</div>
            <div className="muted">Pick a folder and the URL of the application to test.</div>
          </div>
        </button>
        <button className="big" onClick={() => useStore.setState({ modal: { kind: 'folder', purpose: 'open' } })}>
          <FolderOpen size={22} color="var(--accent)" />
          <div>
            <div className="t">Open project</div>
            <div className="muted">A UITester project, or any folder with Robot Framework files.</div>
          </div>
        </button>
        {settings.recent.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 8 }}>
              Recent
            </div>
            <div>
              {settings.recent.map((dir) => (
                <div key={dir} className="recent" onClick={() => void openProject(dir)}>
                  <Folder size={14} color="var(--accent)" />
                  <span className="mono">{dir}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function FolderModal({ purpose }: { purpose: 'open' | 'new' }) {
  const home = useStore((s) => s.home);
  const recent = useStore((s) => s.settings.recent);
  const [dir, setDir] = useState<string>('');
  const [listing, setListing] = useState<{ dir: string; parent?: string; entries: FsEntry[] } | null>(null);
  const [path, setPath] = useState('');

  const load = async (d: string) => {
    const r = await call(api.request('fs.list', { dir: d }));
    if (r) {
      setListing(r);
      setDir(r.dir);
      setPath(r.dir);
    }
  };
  useEffect(() => {
    void load(recent[0] ? recent[0].replace(/[\\/][^\\/]+$/, '') : home);
  }, []);

  const back = () => useStore.setState({ modal: useStore.getState().project ? null : { kind: 'start' } });
  const choose = (d: string) => {
    if (purpose === 'open') void openProject(d);
    else useStore.setState({ modal: { kind: 'new', dir: d } });
  };

  return (
    <Modal
      title={purpose === 'open' ? 'Open project folder' : 'Choose a folder for the new project'}
      onClose={back}
      footer={
        <>
          <button className="btn" onClick={back}>
            Cancel
          </button>
          <button className="btn primary" disabled={!path} onClick={() => choose(path)}>
            {purpose === 'open' ? 'Open' : 'Use this folder'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="icon-btn" title="Up" disabled={listing?.parent === undefined} onClick={() => listing?.parent !== undefined && void load(listing.parent)}>
            <ArrowUp size={16} />
          </button>
          <input
            className="input mono grow"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load(path)}
            placeholder="Folder path"
          />
          <button
            className="icon-btn"
            title="New folder"
            onClick={async () => {
              const name = prompt('New folder name');
              if (!name || !dir) return;
              const sep = dir.includes('\\') ? '\\' : '/';
              const r = await call(api.request('fs.mkdir', { dir: `${dir.replace(/[\\/]$/, '')}${sep}${name}` }));
              if (r) await load(r.dir);
            }}
          >
            <FolderPlus size={16} />
          </button>
        </div>
        <div className="folder-list">
          {listing?.entries.length === 0 && <div className="empty">No sub folders</div>}
          {listing?.entries.map((e) => (
            <div key={e.path} className={`folder${e.isProject ? ' project' : ''}`} onClick={() => setPath(e.path)} onDoubleClick={() => (e.isProject && purpose === 'open' ? choose(e.path) : void load(e.path))}>
              {listing.dir === '' ? <HardDrive size={14} /> : e.isProject ? <TestTube2 size={14} /> : <Folder size={14} color="var(--text-2)" />}
              <span>{e.name}</span>
              {e.isProject && <span className="badge accent">UITester project</span>}
            </div>
          ))}
        </div>
        <div className="kbd-hint" style={{ marginTop: 6 }}>
          Double-click to open a folder.
        </div>
      </div>
    </Modal>
  );
}

export function NewProjectModal({ dir }: { dir: string }) {
  const [name, setName] = useState(dir.split(/[\\/]/).filter(Boolean).pop() ?? 'My project');
  const [url, setUrl] = useState('https://');
  const valid = /^(https?|file):\/\/.+/.test(url) && name.trim();
  const create = async () => {
    const r = await call(api.request('project.create', { dir, name: name.trim(), url: url.trim() }));
    if (r) {
      loadProject(r.dir, r.project);
      toast('Project created. Click elements in Record mode to add events.');
    }
  };
  return (
    <Modal
      title="New project"
      onClose={() => useStore.setState({ modal: { kind: 'folder', purpose: 'new' } })}
      footer={
        <>
          <button className="btn" onClick={() => useStore.setState({ modal: { kind: 'folder', purpose: 'new' } })}>
            Back
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="field">
          <label>Folder</label>
          <div className="mono muted">{dir}</div>
        </div>
        <div className="field">
          <label>Project name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>URL (required)</label>
          <input className="input mono" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && void create()} />
          <span className="muted">Stored as the ${'{URL}'} parameter; every test starts here.</span>
        </div>
      </div>
    </Modal>
  );
}
