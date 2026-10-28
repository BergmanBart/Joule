import { Copy, FlaskConical, MoreHorizontal, Pencil, Play, PlayCircle, Plus, Puzzle, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Menu, MenuItem } from '../components/ui';
import {
  addKeyword,
  addTest,
  deleteKeyword,
  deleteTest,
  duplicateTest,
  editTest,
  renameKeyword,
  runRobot,
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

export function TestsPanel() {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const run = useStore((s) => s.run);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!project) return null;

  const resultFor = (id: string) => {
    if (run.kind !== 'robot') return undefined;
    if (run.running && run.testIds.includes(id)) return 'running';
    return run.results?.find((r) => r.testId === id)?.status;
  };

  return (
    <>
      <div className="column-header">
        <span className="title">Tests</span>
        <button className="icon-btn" title="Run all tests with Robot Framework (uses the run plan)" disabled={run.running} onClick={() => runRobot({ headless: project.settings.headlessRunAll })}>
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
                <button className="icon-btn small" title="Run with Robot Framework" disabled={run.running} onClick={() => runRobot({ testIds: [t.id] })}>
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

        <div className="section-label">
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
      </div>
    </>
  );
}
