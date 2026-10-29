import { AlertTriangle, Dices, Plus, Trash2, Variable } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ENVIRONMENTS, PARAM_NAME, randomFromRegex, regexError, resolveParameters, type Environment, type Parameter, type ResolvedParameter } from '@joule/core';
import { Modal, TextField } from '../components/ui';
import { edit, editTest, useStore } from '../store';

const PREVIEW: CSSProperties = { marginTop: 2, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 };

function withKind(p: Parameter, kind: string): Parameter {
  const { kind: _, ...text } = p;
  return kind === 'random' ? { ...text, kind: 'random' } : text;
}

function draw(pattern: string): string {
  try {
    return randomFromRegex(pattern);
  } catch {
    return '';
  }
}

/** A sample of a random parameter, with a button to draw another one. */
function RandomPreview({ pattern, error }: { pattern: string; error?: string }) {
  const [sample, setSample] = useState(() => draw(pattern));
  useEffect(() => setSample(draw(pattern)), [pattern]);
  if (error) return <div style={{ ...PREVIEW, color: 'var(--danger)' }} title={error}>{error}</div>;
  return (
    <div className="row muted" style={{ gap: 4, marginTop: 2 }}>
      <span className="mono" style={{ ...PREVIEW, marginTop: 0 }} title={sample}>
        e.g. {sample || '(empty)'}
      </span>
      <button className="icon-btn small" title="Draw another sample" onClick={() => setSample(draw(pattern))}>
        <Dices size={12} />
      </button>
    </div>
  );
}

/** The value of a text parameter after its ${references} are filled in. */
function TextPreview({ r }: { r: ResolvedParameter }) {
  if (r.error) return <div style={{ ...PREVIEW, color: 'var(--danger)' }} title={r.error}>{r.error}</div>;
  if (r.value === r.raw) return null;
  return (
    <div className="muted mono" style={PREVIEW} title={r.value}>
      = {r.value}
    </div>
  );
}

/** Field for a value or (random parameters) a regex, marked when the regex is not usable. */
function ValueCell({ value, random, placeholder, onCommit }: { value: string; random: boolean; placeholder?: string; onCommit: (v: string) => void }) {
  const error = random && value ? regexError(value) : undefined;
  return (
    <div title={error}>
      <TextField value={value} mono placeholder={placeholder} onCommit={onCommit} className={error ? 'invalid' : ''} />
    </div>
  );
}

/**
 * Editable table of parameters with a value per environment. `resolved` holds the values for
 * the active environment, shown under the default value.
 */
export function ParamTable({
  params,
  onChange,
  resolved,
  locked = [],
  shadowed = [],
}: {
  params: Parameter[];
  onChange: (p: Parameter[]) => void;
  resolved: ResolvedParameter[];
  locked?: string[];
  shadowed?: string[];
}) {
  const env = useStore((s) => s.project?.settings.environment);
  const update = (i: number, fn: (p: Parameter) => Parameter) => onChange(params.map((p, j) => (j === i ? fn(p) : p)));
  const names = params.map((p) => p.name);
  const resolvedOf = (p: Parameter) => resolved.find((r) => r.name === p.name);
  const cycles = [...new Set(params.flatMap((p) => (p.kind !== 'random' && resolvedOf(p)?.error) || []))];
  const add = (extra: Partial<Parameter>, prefix: string) => {
    let n = 1;
    while (names.includes(`${prefix}_${n}`)) n++;
    onChange([...params, { name: `${prefix}_${n}`, values: { default: '' }, ...extra }]);
  };
  return (
    <>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 150 }}>Name</th>
            <th style={{ width: 86 }}>Type</th>
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
            const random = p.kind === 'random';
            const r = resolvedOf(p);
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
                  <select
                    className="select"
                    value={random ? 'random' : 'text'}
                    title="Text: a fixed value, which can use other parameters as ${NAME}. Regex: a random value matching the pattern, drawn again every time."
                    onChange={(e) => update(i, (x) => withKind(x, e.target.value))}
                  >
                    <option value="text">Text</option>
                    <option value="random">Regex</option>
                  </select>
                </td>
                <td style={{ verticalAlign: 'top' }}>
                  <ValueCell
                    value={p.values.default}
                    random={random}
                    placeholder={random ? 'regex, e.g. [A-Z]{3}\\d{4}' : undefined}
                    onCommit={(v) => update(i, (x) => ({ ...x, values: { ...x.values, default: v } }))}
                  />
                  {r && (random ? <RandomPreview pattern={r.raw} error={r.error} /> : <TextPreview r={r} />)}
                </td>
                {ENVIRONMENTS.map((e: Environment) => (
                  <td key={e} style={{ verticalAlign: 'top' }}>
                    <ValueCell
                      value={p.values[e] ?? ''}
                      random={random}
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
      {cycles.map((c) => (
        <div key={c} className="notice err" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} /> {c}. References in a cycle are left as they are.
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn small" onClick={() => add({}, 'PARAM')}>
          <Plus size={13} /> Add parameter
        </button>
        <button
          className="btn small"
          title="A value drawn from a regular expression, new every time the start page is opened or a test is run"
          onClick={() => add({ kind: 'random', values: { default: '[A-Z0-9]{8}' } }, 'RANDOM')}
        >
          <Dices size={13} /> Add random parameter
        </button>
      </div>
    </>
  );
}

const COMBINE_HELP = (
  <>
    Combine parameters by using <span className="mono">${'{NAME}'}</span> inside a value, e.g. <span className="mono">${'{BASE_URL}'}/case/${'{CASE_ID}'}</span>. A{' '}
    <b>Regex</b> parameter gets a new random value every time the start page is opened or a test is run.
  </>
);

export function ParamsModal() {
  const project = useStore((s) => s.project)!;
  const drawn = useStore((s) => s.drawn);
  const resolved = useMemo(() => resolveParameters(project, undefined, undefined, { reuse: drawn }), [project, drawn]);
  return (
    <Modal title="Project parameters" wide onClose={() => useStore.setState({ modal: null })} icon={<Variable size={18} color="var(--accent)" />}>
      <div className="modal-body">
        <p className="muted" style={{ marginTop: 0 }}>
          Use a parameter anywhere as <span className="mono">${'{NAME}'}</span>. Leave an environment empty to use the default. The highlighted environment is the active one.
        </p>
        <p className="muted">{COMBINE_HELP} Project parameters can only use other project parameters.</p>
        <ParamTable params={project.parameters} resolved={resolved} locked={['URL']} onChange={(parameters) => edit((p) => ({ ...p, parameters }))} />
      </div>
    </Modal>
  );
}

export function TestSettingsModal({ testId }: { testId: string }) {
  const project = useStore((s) => s.project)!;
  const drawn = useStore((s) => s.drawn);
  const test = project.tests.find((t) => t.id === testId);
  const resolved = useMemo(() => (test ? resolveParameters(project, test, undefined, { reuse: drawn }).filter((r) => r.source === 'test') : []), [project, test, drawn]);
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
        <p className="muted" style={{ marginTop: 0 }}>
          Only for this test. A test parameter with the same name as a project parameter overrides it. {COMBINE_HELP} Test parameters can use test and project
          parameters.
        </p>
        {shadowed.length > 0 && (
          <div className="notice warn">
            <AlertTriangle size={14} /> Overriding project parameter{shadowed.length > 1 ? 's' : ''}: {shadowed.join(', ')}
          </div>
        )}
        <ParamTable params={test.parameters} resolved={resolved} shadowed={shadowed} onChange={(parameters) => editTest(test.id, (t) => ({ ...t, parameters }))} />
      </div>
    </Modal>
  );
}
