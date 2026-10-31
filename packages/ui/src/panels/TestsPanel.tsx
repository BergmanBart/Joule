import { BookOpen, ChevronDown, ChevronRight, Copy, FileCode2, FlaskConical, Folder, FolderOpen, MoreHorizontal, Pencil, Play, PlayCircle, Plus, Puzzle, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CustomKeyword } from '@joule/core';
import { ContextMenu, Menu, MenuItem } from '../components/ui';
import {
  addCustomCall,
  addKeyword,
  addTest,
  deleteKeyword,
  deleteTest,
  duplicateTest,
  editTest,
  renameKeyword,
  runRobot,
  scanCustomKeywords,
  selectContainer,
  useStore,
} from '../store';

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="input"
      style={{ height: 24 }}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v.trim() || null);
        if (e.key === 'Escape') onDone(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: { name: string; path: string; keywords: CustomKeyword[] }[];
}

/** Folders and files below custom_keywords/, following each keyword's source path. */
function customTree(keywords: CustomKeyword[]): TreeFolder {
  const root: TreeFolder = { name: 'Custom Keywords', path: '', folders: [], files: [] };
  for (const k of keywords) {
    const parts = k.source.split('/').slice(1);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((f) => f.name === part);
      if (!next) node.folders.push((next = { name: part, path: `${node.path}/${part}`, folders: [], files: [] }));
      node = next;
    }
    let file = node.files.find((f) => f.path === k.source);
    if (!file) node.files.push((file = { name: (parts[parts.length - 1] ?? k.source).replace(/\.(robot|resource)$/i, ''), path: k.source, keywords: [] }));
    file.keywords.push(k);
  }
  return root;
}

const COLLAPSED_KEY = 'joule.customCollapsed';

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

const TREE_INDENT = 14;

function TreeRow({ depth, open, icon, label, count, onToggle }: { depth: number; open: boolean; icon: ReactNode; label: string; count: number; onToggle: () => void }) {
  return (
    <div className="list-item tree-folder" style={{ paddingLeft: 8 + depth * TREE_INDENT }} onClick={onToggle} title={label}>
      {open ? <ChevronDown size={13} color="var(--muted)" /> : <ChevronRight size={13} color="var(--muted)" />}
      {icon}
      <span className="name">{label}</span>
      <span className="badge">{count}</span>
    </div>
  );
}

/** Keywords from custom_keywords/ as a folder tree; clicking a keyword adds a call to the open steps. */
function CustomKeywordTree({ keywords }: { keywords: CustomKeyword[] }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* storage unavailable */
    }
  };
  const total = (f: TreeFolder): number => f.files.reduce((n, x) => n + x.keywords.length, 0) + f.folders.reduce((n, x) => n + total(x), 0);

  const folder = (f: TreeFolder, depth: number): ReactNode[] => {
    const key = `dir:${f.path}`;
    const open = !collapsed.has(key);
    const out: ReactNode[] = [
      <TreeRow key={key} depth={depth} open={open} label={f.name} count={total(f)} onToggle={() => toggle(key)} icon={open ? <FolderOpen size={14} color="#38bdf8" /> : <Folder size={14} color="#38bdf8" />} />,
    ];
    if (!open) return out;
    for (const sub of [...f.folders].sort((a, b) => a.name.localeCompare(b.name))) out.push(...folder(sub, depth + 1));
    for (const file of [...f.files].sort((a, b) => a.name.localeCompare(b.name))) {
      const fileKey = `file:${file.path}`;
      const fileOpen = !collapsed.has(fileKey);
      out.push(<TreeRow key={fileKey} depth={depth + 1} open={fileOpen} label={file.name} count={file.keywords.length} onToggle={() => toggle(fileKey)} icon={<FileCode2 size={14} color="var(--text-2)" />} />);
      if (!fileOpen) continue;
      for (const k of file.keywords) {
        out.push(
          <div key={`${file.path}#${k.name}`} className="list-item custom-kw" style={{ paddingLeft: 8 + (depth + 2) * TREE_INDENT + 13 + 8 }} onClick={() => addCustomCall(k)} title={k.doc ? `${k.name}\n\n${k.doc}` : `Add "${k.name}" to the steps`}>
            <BookOpen size={14} color="#38bdf8" />
            <span className="name">{k.name}</span>
            <span className="actions">
              <button
                className="icon-btn small"
                title="Add to the steps"
                onClick={(e) => {
                  e.stopPropagation();
                  addCustomCall(k);
                }}
              >
                <Plus size={13} />
              </button>
            </span>
          </div>,
        );
      }
    }
    return out;
  };
  return <div className="custom-tree">{folder(customTree(keywords), 0)}</div>;
}

export function TestsPanel() {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const runKind = useStore((s) => s.run.kind);
  const running = useStore((s) => s.run.running);
  const runTestIds = useStore((s) => s.run.testIds);
  const results = useStore((s) => s.run.results);
  const customKeywords = useStore((s) => s.customKeywords);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  if (!project) return null;
  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const resultFor = (id: string) => {
    if (runKind !== 'robot') return undefined;
    if (running && runTestIds.includes(id)) return 'running';
    return results?.find((r) => r.testId === id)?.status;
  };

  return (
    <>
      <div className="column-header">
        <span className="title">Tests</span>
        <button className="icon-btn" title="Run all tests with Robot Framework (uses the run plan)" disabled={running} onClick={() => runRobot({ headless: project.settings.headlessRunAll })}>
          <PlayCircle size={16} />
        </button>
        <button className="icon-btn" title="New test" onClick={addTest}>
          <Plus size={16} />
        </button>
      </div>
      <div className="column-body">
        {project.tests.map((t) => {
          const status = resultFor(t.id);
          return (
            <div
              key={t.id}
              className={`list-item${current?.kind === 'test' && current.id === t.id ? ' active' : ''}`}
              onClick={() => selectContainer({ kind: 'test', id: t.id })}
              onDoubleClick={() => setRenaming(t.id)}
            >
              <FlaskConical size={14} color="var(--text-2)" />
              {renaming === t.id ? (
                <InlineRename
                  value={t.name}
                  onDone={(v) => {
                    if (v) editTest(t.id, (x) => ({ ...x, name: v }));
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="name" title={t.name}>
                  {t.name}
                </span>
              )}
              {status && <span className={`status-dot ${status}`} title={status} />}
              {t.kind === 'smoke' && <span className="tag smoke">smoke</span>}
              {t.flow === 'unhappy' && <span className="tag unhappy">unhappy</span>}
              <span className="actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn small" title="Run with Robot Framework" disabled={running} onClick={() => runRobot({ testIds: [t.id] })}>
                  <Play size={13} />
                </button>
                <Menu
                  align="right"
                  button={(toggle) => (
                    <button className="icon-btn small" onClick={toggle} title="More">
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem icon={<Settings2 size={14} />} onClick={() => (close(), useStore.setState({ modal: { kind: 'test', testId: t.id } }))}>
                        Test settings & parameters
                      </MenuItem>
                      <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), setRenaming(t.id))}>
                        Rename
                      </MenuItem>
                      <MenuItem icon={<Copy size={14} />} onClick={() => (close(), duplicateTest(t.id))}>
                        Duplicate
                      </MenuItem>
                      <div className="sep" />
                      <MenuItem icon={<Trash2 size={14} />} onClick={() => (close(), confirm(`Delete test "${t.name}"?`) && deleteTest(t.id))}>
                        Delete
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </span>
            </div>
          );
        })}

        <div className="section-label" onContextMenu={openContextMenu} title="Right-click to rescan custom keywords">
          <span>Reusable keywords</span>
          <button className="icon-btn small" title="New reusable keyword" onClick={() => addKeyword()}>
            <Plus size={13} />
          </button>
        </div>
        {project.keywords.length === 0 && <div className="muted" style={{ padding: '2px 12px 8px', fontSize: 12 }}>Group steps and choose “Make reusable” to share them between tests.</div>}
        {project.keywords.map((k) => (
          <div
            key={k.id}
            className={`list-item${current?.kind === 'keyword' && current.id === k.id ? ' active' : ''}`}
            onClick={() => selectContainer({ kind: 'keyword', id: k.id })}
            onDoubleClick={() => setRenaming(k.id)}
          >
            <Puzzle size={14} color="#a78bfa" />
            {renaming === k.id ? (
              <InlineRename
                value={k.name}
                onDone={(v) => {
                  if (v) renameKeyword(k.id, v);
                  setRenaming(null);
                }}
              />
            ) : (
              <span className="name">{k.name}</span>
            )}
            <span className="actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn small" title="Rename" onClick={() => setRenaming(k.id)}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn small" title="Delete keyword" onClick={() => deleteKeyword(k.id)}>
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        ))}
        {customKeywords.length > 0 && (
          <div onContextMenu={openContextMenu}>
            <CustomKeywordTree keywords={customKeywords} />
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <MenuItem
            icon={<RefreshCw size={14} />}
            onClick={() => {
              setContextMenu(null);
              void scanCustomKeywords();
            }}
          >
            Rescan custom keywords
          </MenuItem>
        </ContextMenu>
      )}
    </>
  );
}
