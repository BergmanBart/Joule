import { AlertTriangle, Plus, Trash2, Variable } from 'lucide-react';
import { ENVIRONMENTS, PARAM_NAME, type Environment, type Parameter } from '@joule/core';
import { Modal, TextField } from '../components/ui';
import { edit, editTest, useStore } from '../store';

/** Editable table of parameters with a value per environment. */
export function ParamTable({ params, onChange, locked = [], shadowed = [] }: { params: Parameter[]; onChange: (p: Parameter[]) => void; locked?: string[]; shadowed?: string[] }) {
  const env = useStore((s) => s.project?.settings.environment);
  const update = (i: number, fn: (p: Parameter) => Parameter) => onChange(params.map((p, j) => (j === i ? fn(p) : p)));
  const names = params.map((p) => p.name);
  return (
    <>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 150 }}>Name</th>
            <th>Default</th>
            {ENVIRONMENTS.map((e) => (
              <th key={e} style={{ width: 110, color: e === env ? 'var(--accent)' : undefined }}>
                {e}
              </th>
            ))}
            <th style={{ width: 32 }} />
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => {
            const invalid = !PARAM_NAME.test(p.name) || names.indexOf(p.name) !== i;
            return (
              <tr key={i}>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {locked.includes(p.name) ? (
                      <span className="mono" style={{ padding: '0 9px' }} title="Required parameter">
                        {p.name}
                      </span>
                    ) : (
                      <TextField value={p.name} mono onCommit={(v) => update(i, (x) => ({ ...x, name: v.trim() }))} className={invalid ? 'invalid' : ''} />
                    )}
                    {shadowed.includes(p.name) && (
                      <span title="Overrides the project parameter with the same name" style={{ color: 'var(--warn)', display: 'flex' }}>
                        <AlertTriangle size={13} />
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <TextField value={p.values.default} mono onCommit={(v) => update(i, (x) => ({ ...x, values: { ...x.values, default: v } }))} />
                </td>
                {ENVIRONMENTS.map((e: Environment) => (
                  <td key={e}>
                    <TextField
                      value={p.values[e] ?? ''}
                      mono
                      placeholder="default"
                      onCommit={(v) => update(i, (x) => ({ ...x, values: { ...x.values, [e]: v || undefined } }))}
                    />
                  </td>
                ))}
                <td>
                  {!locked.includes(p.name) && (
                    <button className="icon-btn small" title="Remove" onClick={() => onChange(params.filter((_, j) => j !== i))}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {params.some((p, i) => !PARAM_NAME.test(p.name) || names.indexOf(p.name) !== i) && (
        <div className="notice err" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} /> Names must be unique and use letters, digits and underscores (e.g. USER_NAME).
        </div>
      )}
      <button
        className="btn small"
        style={{ marginTop: 10 }}
        onClick={() => {
          let n = 1;
          while (names.includes(`PARAM_${n}`)) n++;
          onChange([...params, { name: `PARAM_${n}`, values: { default: '' } }]);
        }}
      >
        <Plus size={13} /> Add parameter
      </button>
    </>
  );
}

export function ParamsModal() {
  const project = useStore((s) => s.project)!;
  return (
    <Modal title="Project parameters" wide onClose={() => useStore.setState({ modal: null })} icon={<Variable size={18} color="var(--accent)" />}>
      <div className="modal-body">
        <p className="muted" style={{ marginTop: 0 }}>
          Use a parameter anywhere as <span className="mono">${'{NAME}'}</span>. Leave an environment empty to use the default. The highlighted environment is the active one.
        </p>
        <ParamTable params={project.parameters} locked={['URL']} onChange={(parameters) => edit((p) => ({ ...p, parameters }))} />
      </div>
    </Modal>
  );
}

export function TestSettingsModal({ testId }: { testId: string }) {
  const project = useStore((s) => s.project)!;
  const test = project.tests.find((t) => t.id === testId);
  if (!test) return null;
  const projectNames = project.parameters.map((p) => p.name);
  const shadowed = test.parameters.map((p) => p.name).filter((n) => projectNames.includes(n));
  return (
    <Modal title={`Test settings · ${test.name}`} wide onClose={() => useStore.setState({ modal: null })}>
      <div className="modal-body">
        <div className="row" style={{ gap: 24, marginBottom: 16 }}>
          <div className="field">
            <label>Flow</label>
            <div className="segmented">
              {(['happy', 'unhappy'] as const).map((f) => (
                <button key={f} className={test.flow === f ? 'on' : ''} onClick={() => editTest(test.id, (t) => ({ ...t, flow: f }))}>
                  {f === 'happy' ? 'Happy flow' : 'Unhappy flow'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Kind</label>
            <div className="segmented">
              {(['smoke', 'regression'] as const).map((k) => (
                <button key={k} className={test.kind === k ? 'on' : ''} onClick={() => editTest(test.id, (t) => ({ ...t, kind: k }))}>
                  {k === 'smoke' ? 'Smoke test' : 'Regression test'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="label" style={{ marginBottom: 6 }}>
          Test parameters
        </div>
        <p className="muted" style={{ marginTop: 0 }}>Only for this test. A test parameter with the same name as a project parameter overrides it.</p>
        {shadowed.length > 0 && (
          <div className="notice warn">
            <AlertTriangle size={14} /> Overriding project parameter{shadowed.length > 1 ? 's' : ''}: {shadowed.join(', ')}
          </div>
        )}
        <ParamTable params={test.parameters} shadowed={shadowed} onChange={(parameters) => editTest(test.id, (t) => ({ ...t, parameters }))} />
      </div>
    </Modal>
  );
}
