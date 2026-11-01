import { AlertTriangle, ArrowUpFromLine, CheckCircle2, ChevronDown, ChevronRight, Code2, Crosshair, ExternalLink, Link2Off, Plus, Puzzle, SquareDashed, Ungroup, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  availableProps,
  baseSelector,
  buildSelector,
  defaultScopeUse,
  describeStep,
  findCustomKeyword,
  findStep,
  interpolate,
  isCheckable,
  isRequired,
  isSelect,
  isTextInput,
  newElementCondition,
  ASSERT_PROPERTIES,
  NUMBER_OPERATORS,
  OPERATORS,
  scopeSelector,
  stepSignature,
  walk,
  type ActionKind,
  type Assertion,
  type AssertProperty,
  type BaseLocator,
  type Condition,
  type ElementCondition,
  type CustomCallStep,
  type CustomKeywordArg,
  type ElementDescriptor,
  type Locator,
  type Operator,
  type Scope,
  type Step,
  type ValueCondition,
} from '@joule/core';
import { api } from '../api';
import { NumberField, TextField } from '../components/ui';
import { stepMeta, TypeIcon } from '../stepMeta';
import {
  clearSelection,
  containerSteps,
  makeReusable,
  selectContainer,
  setSearchCollapsed,
  toast,
  ungroup,
  unlinkKeyword,
  updateCurrentStep,
  useStore,
  type PickTarget,
  type ScopePart,
} from '../store';
import { useParams } from './BrowserPanel';

type Upd = (fn: (s: Step) => Step) => void;

function actionsFor(d: ElementDescriptor): ActionKind[] {
  if (isTextInput(d)) return ['fill', 'click', 'dblclick', 'rightclick', 'press', 'hover'];
  if (isSelect(d)) return ['select', 'click', 'hover'];
  if (isCheckable(d)) return ['check', 'uncheck', 'click', 'hover'];
  // buttons and every other element
  return ['click', 'dblclick', 'rightclick', 'hover', 'press'];
}

const ACTION_NAMES: Record<ActionKind, string> = {
  click: 'Click',
  dblclick: 'Double click',
  rightclick: 'Right click',
  fill: 'Enter text',
  hover: 'Hover',
  select: 'Select option',
  check: 'Check',
  uncheck: 'Uncheck',
  press: 'Press key',
};

const STATES = ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'editable', 'attached', 'detached'];

function ParamList() {
  const project = useStore((s) => s.project);
  const params = useParams();
  return (
    <datalist id="param-refs">
      {Object.keys(params).map((n) => (
        <option key={n} value={`\${${n}}`} />
      ))}
      {project?.parameters.length === 0 && null}
    </datalist>
  );
}

/** Text field with a ${param} picker next to it. */
function ValueField({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const params = useParams();
  const resolved = interpolate(value, params);
  return (
    <>
      <div className="row">
        <div className="grow">
          <TextField value={value} onCommit={onCommit} placeholder={placeholder} list="param-refs" mono />
        </div>
        <select className="select" style={{ width: 42 }} value="" title="Insert a parameter" onChange={(e) => e.target.value && onCommit(value + `\${${e.target.value}}`)}>
          <option value="">$</option>
          {Object.keys(params).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {resolved !== value && <div className="muted mono" style={{ marginTop: 4 }}>= {resolved}</div>}
    </>
  );
}

function MatchCount({ selector }: { selector: string }) {
  const [state, setState] = useState<{ count: number; error?: string } | null>(null);
  const status = useStore((s) => s.view.status);
  const url = useStore((s) => s.view.url);
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await api.request('view.count', { selector }).catch(() => null);
      if (!cancelled) setState(r);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [selector, status, url]);
  if (!state) return null;
  if (state.error) return <div className="notice err"><AlertTriangle size={14} /> Invalid selector: {state.error}</div>;
  if (state.count === 1)
    return (
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="badge ok">
          <CheckCircle2 size={12} /> Finds exactly 1 element
        </span>
      </div>
    );
  return (
    <div className="notice warn">
      <AlertTriangle size={14} />
      <span>
        {state.count === 0
          ? 'Finds no element on the current page. That is fine if the element only appears later in the test.'
          : `Finds ${state.count} elements (shown with dashed outlines). Robot Framework's strict mode will fail on this; add more search properties.`}
      </span>
    </div>
  );
}

/** Checkboxes for the properties used to find one element. */
function PropToggles<L extends BaseLocator>({ locator, onChange, exclude = [] }: { locator: L; onChange: (l: L) => void; exclude?: string[] }) {
  const props = availableProps(locator.props).filter((p) => !exclude.includes(p.key));
  const use = new Set(locator.use);
  const toggle = (key: string) => {
    const next = new Set(use);
    if (next.has(key)) next.delete(key);
    else {
      // xpath / css path are exclusive with the other properties
      if (key === 'xpath' || key === 'css') next.clear();
      else {
        next.delete('xpath');
        next.delete('css');
      }
      next.add(key);
    }
    onChange({ ...locator, use: props.map((p) => p.key).filter((k) => next.has(k)), custom: undefined });
  };
  return (
    <div className="prop-list">
      {props.map((p) => (
        <label key={p.key} className="prop">
          <input type="checkbox" checked={use.has(p.key)} onChange={() => toggle(p.key)} style={{ accentColor: 'var(--accent)' }} />
          <span className="k">{p.label}</span>
          <span className="v" title={p.value}>
            {p.value}
          </span>
        </label>
      ))}
    </div>
  );
}

type PickField = NonNullable<PickTarget>['field'];

function samePart(a?: ScopePart, b?: ScopePart): boolean {
  if (a?.kind === 'has' && b?.kind === 'has') return a.index === b.index;
  return a?.kind === b?.kind;
}

/** "Must be inside": a parent the element must be in, and elements that parent must also contain. */
function ScopeEditor({ locator, onChange, pickField, stepId }: { locator: Locator; onChange: (l: Locator) => void; pickField: PickField; stepId: string }) {
  const params = useParams();
  const pickTarget = useStore((s) => s.pickTarget);
  const picking = (part: ScopePart) => pickTarget?.stepId === stepId && pickTarget.field === pickField && samePart(pickTarget.part, part);
  const pick = (part: ScopePart) => useStore.setState({ pickTarget: picking(part) ? null : { stepId, field: pickField, part } });
  const within = locator.within;
  const parentPart: ScopePart = { kind: 'parent' };

  if (!within)
    return (
      <div className="row" style={{ marginBottom: 10 }}>
        <button
          className={`btn small${picking(parentPart) ? ' primary' : ''}`}
          title="Pick a parent (e.g. a row or card) in the browser view that the element must be inside"
          onClick={() => pick(parentPart)}
        >
          <SquareDashed size={12} /> {picking(parentPart) ? 'Click a parent in browser…' : 'Must be inside…'}
        </button>
      </div>
    );

  const setWithin = (w: Scope | undefined) => onChange({ ...locator, within: w });
  const setHas = (has: BaseLocator[]) => setWithin({ ...within, has });
  const upOneLevel = async () => {
    // the parent of the scope that actually holds the element
    const selector = `${scopeSelector(within)} >> internal:has=${JSON.stringify(baseSelector(locator))}`;
    const r = await api.request('view.describeParent', { selector: interpolate(selector, params) }).catch(() => null);
    if (!r?.descriptor) return toast('No wider parent found on the current page', 'error');
    setWithin({ ...within, parent: { props: r.descriptor, use: defaultScopeUse(r.descriptor) } });
  };
  const nextHas: ScopePart = { kind: 'has', index: within.has.length };

  return (
    <div className="scope">
      <div className="row scope-head">
        <span className="label grow">Must be inside</span>
        <button className="icon-btn small" title="Up one level: use the parent of this parent" onClick={upOneLevel}>
          <ArrowUpFromLine size={13} />
        </button>
        <button className={`icon-btn small${picking(parentPart) ? ' active' : ''}`} title="Pick the parent again in the browser view" onClick={() => pick(parentPart)}>
          <Crosshair size={13} />
        </button>
        <button className="icon-btn small" title="Remove: no longer require a parent" onClick={() => setWithin(undefined)}>
          <X size={13} />
        </button>
      </div>
      {picking(parentPart) && <div className="muted scope-hint">Click a parent of the element in the browser view.</div>}
      <PropToggles locator={within.parent} onChange={(parent) => setWithin({ ...within, parent })} />
      {within.has.map((h, i) => {
        const part: ScopePart = { kind: 'has', index: i };
        return (
          <div key={i}>
            <div className="row scope-head">
              <span className="label grow">{i === 0 ? 'Parent also contains' : 'And contains'}</span>
              <button className={`icon-btn small${picking(part) ? ' active' : ''}`} title="Pick this element again inside the parent" onClick={() => pick(part)}>
                <Crosshair size={13} />
              </button>
              <button className="icon-btn small" title="Remove this condition" onClick={() => setHas(within.has.filter((_, j) => j !== i))}>
                <X size={13} />
              </button>
            </div>
            {picking(part) && <div className="muted scope-hint">Click an element inside the parent in the browser view.</div>}
            {/* absolute paths don't work inside :has() */}
            <PropToggles locator={h} onChange={(next) => setHas(within.has.map((x, j) => (j === i ? next : x)))} exclude={['xpath', 'css']} />
          </div>
        );
      })}
      <button
        className={`btn small${picking(nextHas) ? ' primary' : ' ghost'}`}
        title="Pick an element inside the parent that must also exist, e.g. the name in a table row"
        onClick={() => pick(nextHas)}
      >
        <Plus size={12} /> {picking(nextHas) ? 'Click inside the parent…' : 'Parent also contains…'}
      </button>
    </div>
  );
}

function LocatorEditor({ locator, onChange, pickField, stepId }: { locator: Locator; onChange: (l: Locator) => void; pickField: PickField; stepId: string }) {
  const params = useParams();
  const selector = buildSelector(locator);
  const collapsed = useStore((s) => s.searchCollapsed);
  const picking = useStore((s) => s.pickTarget?.stepId === stepId && !s.pickTarget.part);
  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="collapse-toggle grow" aria-expanded={!collapsed} onClick={() => setSearchCollapsed(!collapsed)}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="label">Search details</span>
        </button>
        <button
          className={`btn small${picking ? ' primary' : ''}`}
          title="Pick the element again in the browser view"
          onClick={() => useStore.setState({ pickTarget: picking ? null : { stepId, field: pickField } })}
        >
          <Crosshair size={12} /> {picking ? 'Click in browser…' : 'Pick element'}
        </button>
      </div>
      {collapsed ? (
        <div className="selector-preview one-line" title={selector}>
          {selector}
        </div>
      ) : (
        <>
          {!locator.custom && <PropToggles locator={locator} onChange={onChange} />}
          <ScopeEditor locator={locator} onChange={onChange} pickField={pickField} stepId={stepId} />
          {locator.within && !locator.custom && locator.use.includes('xpath') && (
            <div className="notice warn">
              <AlertTriangle size={14} /> Inside a parent an xpath is searched relative to that parent. Use tag, class or text instead.
            </div>
          )}
          <div className="field">
            <label>{locator.custom ? 'Custom selector' : 'Selector'}</label>
            {locator.custom !== undefined ? (
              <TextField value={locator.custom} onCommit={(v) => onChange({ ...locator, custom: v || undefined })} mono placeholder="css=… / xpath=… / text=…" />
            ) : (
              <div className="selector-preview">{selector}</div>
            )}
            {locator.custom !== undefined && locator.within && <div className="selector-preview">{selector}</div>}
            <div className="row">
              {locator.custom === undefined ? (
                <button className="btn small ghost" onClick={() => onChange({ ...locator, custom: baseSelector(locator) })}>
                  Edit as custom selector
                </button>
              ) : (
                locator.props.tag !== '*' && (
                  <button className="btn small ghost" onClick={() => onChange({ ...locator, custom: undefined })}>
                    Back to property selection
                  </button>
                )
              )}
            </div>
          </div>
          <MatchCount selector={interpolate(selector, params)} />
        </>
      )}
    </div>
  );
}

const PROPERTY_NAMES: Record<AssertProperty, string> = {
  text: 'Text',
  value: 'Value (inputs)',
  attribute: 'Attribute',
  count: 'Number of elements',
  state: 'State',
};

/** The assertion after picking another property: an expected value that fits it. */
function withProperty(a: Assertion, property: AssertProperty): Assertion {
  if (property === 'state') return { ...a, property, operator: a.operator === '!=' ? '!=' : '==', expected: 'visible' };
  if (property === 'count') {
    // "is visible" becomes "at least 1"
    const operator = a.property !== 'state' && NUMBER_OPERATORS.includes(a.operator) ? a.operator : '>=';
    return { ...a, property, operator, expected: /^\d+$/.test(a.expected) ? a.expected : '1' };
  }
  return { ...a, property, expected: a.property === 'state' ? '' : a.expected };
}

function AssertionEditor({
  assertion,
  onChange,
  label = 'Assert that',
  properties = ASSERT_PROPERTIES,
}: {
  assertion: Assertion;
  onChange: (a: Assertion) => void;
  label?: string;
  properties?: readonly AssertProperty[];
}) {
  // a property no longer offered (e.g. a text check in an older if) stays visible so it can be changed
  const shown = properties.includes(assertion.property) ? properties : [...properties, assertion.property];
  const operators = assertion.property === 'count' ? NUMBER_OPERATORS : OPERATORS;
  return (
    <>
      <div className="field">
        <label>{label}</label>
        <div className="row">
          <select className="select grow" value={assertion.property} onChange={(e) => onChange(withProperty(assertion, e.target.value as AssertProperty))}>
            {shown.map((p) => (
              <option key={p} value={p}>
                {PROPERTY_NAMES[p]}
              </option>
            ))}
          </select>
          {assertion.property === 'attribute' && <TextField value={assertion.name ?? ''} onCommit={(v) => onChange({ ...assertion, name: v })} placeholder="e.g. title" />}
        </div>
      </div>
      {assertion.property === 'state' ? (
        <div className="field">
          <label>Is</label>
          <div className="row">
            <select className="select" style={{ width: 110 }} value={assertion.operator === '!=' ? '!=' : '=='} onChange={(e) => onChange({ ...assertion, operator: e.target.value as Assertion['operator'] })}>
              <option value="==">is</option>
              <option value="!=">is not</option>
            </select>
            <select className="select grow" value={assertion.expected} onChange={(e) => onChange({ ...assertion, expected: e.target.value })}>
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label>Operator</label>
            <select className="select" value={assertion.operator} onChange={(e) => onChange({ ...assertion, operator: e.target.value as Assertion['operator'] })}>
              {operators.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Expected value (text or $&#123;parameter&#125;)</label>
            <ValueField value={assertion.expected} onCommit={(v) => onChange({ ...assertion, expected: v })} />
          </div>
        </>
      )}
    </>
  );
}

function ElementDetails({ step, upd }: { step: Extract<Step, { type: 'element' }>; upd: Upd }) {
  const d = step.locator.props;
  const kinds = actionsFor(d);
  const set = (patch: Partial<typeof step>) => upd((s) => ({ ...s, ...patch }) as Step);
  return (
    <>
      <div className="field">
        <label>Type</label>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button className={step.mode === 'action' ? 'on' : ''} onClick={() => set({ mode: 'action', action: step.action ?? { kind: kinds[0] } })}>
            Action
          </button>
          <button className={step.mode === 'assert' ? 'on' : ''} onClick={() => set({ mode: 'assert', assertion: step.assertion ?? { property: 'text', operator: '==', expected: d.text ?? '' } })}>
            Assertion
          </button>
        </div>
      </div>
      {step.mode === 'action' ? (
        <>
          <div className="field">
            <label>Action</label>
            <select className="select" value={step.action?.kind ?? 'click'} onChange={(e) => set({ action: { kind: e.target.value as ActionKind, value: step.action?.value } })}>
              {[...new Set([...kinds, step.action?.kind ?? 'click'])].map((k) => (
                <option key={k} value={k}>
                  {ACTION_NAMES[k]}
                </option>
              ))}
            </select>
          </div>
          {(step.action?.kind === 'fill' || step.action?.kind === 'select' || step.action?.kind === 'press') && (
            <div className="field">
              <label>{step.action.kind === 'fill' ? 'Text to enter' : step.action.kind === 'select' ? 'Option label' : 'Key (e.g. Enter, Tab, Control+A)'}</label>
              <ValueField value={step.action.value ?? ''} onCommit={(v) => set({ action: { ...step.action!, value: v } })} placeholder={step.action.kind === 'fill' ? 'Text or ${PARAMETER}' : ''} />
            </div>
          )}
        </>
      ) : (
        <AssertionEditor assertion={step.assertion ?? { property: 'text', operator: '==', expected: '' }} onChange={(a) => set({ assertion: a })} />
      )}
      <LocatorEditor locator={step.locator} onChange={(l) => set({ locator: l })} pickField="element" stepId={step.id} />
    </>
  );
}

function WaitDetails({ step, upd }: { step: Extract<Step, { type: 'wait' }>; upd: Upd }) {
  const w = step.wait;
  const setWait = (wait: typeof w) => upd((s) => ({ ...s, wait }) as Step);
  return (
    <>
      <div className="field">
        <label>Wait for</label>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button className={w.kind === 'time' ? 'on' : ''} onClick={() => setWait({ kind: 'time', seconds: 1 })}>
            Time
          </button>
          <button className={w.kind === 'load' ? 'on' : ''} onClick={() => setWait({ kind: 'load', state: 'load' })}>
            Page load
          </button>
          <button
            className={w.kind === 'element' ? 'on' : ''}
            onClick={() => {
              if (w.kind !== 'element') useStore.setState({ pickTarget: { stepId: step.id, field: 'wait' } });
            }}
          >
            Element
          </button>
        </div>
      </div>
      {w.kind === 'time' && (
        <div className="field">
          <label>Seconds</label>
          <NumberField value={w.seconds} min={0} step={0.5} onCommit={(seconds) => setWait({ ...w, seconds })} />
        </div>
      )}
      {w.kind === 'load' && (
        <div className="field">
          <label>Until</label>
          <select className="select" value={w.state} onChange={(e) => setWait({ ...w, state: e.target.value as typeof w.state })}>
            <option value="load">Page loaded (load)</option>
            <option value="domcontentloaded">HTML parsed (domcontentloaded)</option>
            <option value="networkidle">No network activity (networkidle)</option>
          </select>
        </div>
      )}
      {w.kind === 'element' && (
        <>
          <div className="field">
            <label>Until the element is</label>
            <select className="select" value={w.state} onChange={(e) => setWait({ ...w, state: e.target.value as typeof w.state })}>
              {['visible', 'hidden', 'attached', 'detached', 'enabled'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Timeout (seconds, empty = project timeout)</label>
            <TextField value={w.timeoutSeconds ? String(w.timeoutSeconds) : ''} onCommit={(v) => setWait({ ...w, timeoutSeconds: Number(v) > 0 ? Number(v) : undefined })} />
          </div>
          <LocatorEditor locator={w.locator} onChange={(locator) => setWait({ ...w, locator })} pickField="wait" stepId={step.id} />
        </>
      )}
      {w.kind !== 'element' && useStore.getState().pickTarget?.stepId === step.id && <div className="notice info"><Crosshair size={14} /> Click the element to wait for in the browser view.</div>}
    </>
  );
}

/** Documentation and file of the custom keyword a step calls, shown right under the title. */
function IfDetails({ step, upd }: { step: Extract<Step, { type: 'if' }>; upd: Upd }) {
  const params = useParams();
  // the condition of the other kind, so switching back and forth does not lose a picked element
  const [other, setOther] = useState<Condition | undefined>();
  const c = step.condition;
  const setCondition = (condition: Condition) => upd((s) => (s.type === 'if' ? { ...s, condition } : s));
  const switchTo = (kind: 'element' | 'value') => {
    if ((c.kind ?? 'element') === kind) return;
    const first = Object.keys(params)[0];
    setOther(c);
    setCondition(other ?? (kind === 'value' ? { kind, value: first ? `\${${first}}` : '', operator: '==', expected: '' } : newElementCondition()));
    if (kind === 'value' && useStore.getState().pickTarget?.stepId === step.id) useStore.setState({ pickTarget: null });
  };
  return (
    <>
      <div className="notice info">
        Runs the Then steps when the condition is true, otherwise the Else steps. To fill a branch, click Then or Else in the step list, then record in the browser view or use Add. You can also drag steps into a branch.
      </div>
      <div className="field">
        <label>Check</label>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button className={c.kind !== 'value' ? 'on' : ''} onClick={() => switchTo('element')} title="The state or number of an element on the page">
            Element
          </button>
          <button className={c.kind === 'value' ? 'on' : ''} onClick={() => switchTo('value')} title="Compare a parameter (or any text) with a value">
            Value
          </button>
        </div>
      </div>
      {c.kind === 'value' ? <ValueConditionEditor condition={c} onChange={setCondition} /> : <ElementConditionEditor step={step} condition={c} onChange={setCondition} />}
    </>
  );
}

function ElementConditionEditor({ step, condition, onChange }: { step: Step; condition: ElementCondition; onChange: (c: ElementCondition) => void }) {
  const loc = condition.locator;
  // what a new if starts with: the whole page, which is always visible
  const unpicked = !loc.custom && !loc.within && loc.props.tag === 'body' && loc.use.join() === 'tag';
  return (
    <>
      {unpicked && (
        <div className="notice warn">
          <AlertTriangle size={14} /> No element picked yet: the condition checks the whole page, so it is always true. Use Pick element below.
        </div>
      )}
      <div className="field">
        <label>Element to check</label>
      </div>
      <LocatorEditor locator={loc} onChange={(l) => onChange({ ...condition, locator: l })} pickField="condition" stepId={step.id} />
      <AssertionEditor label="Condition: check its" properties={['state', 'count']} assertion={condition.assertion} onChange={(a) => onChange({ ...condition, assertion: a })} />
    </>
  );
}

function ValueConditionEditor({ condition, onChange }: { condition: ValueCondition; onChange: (c: ValueCondition) => void }) {
  return (
    <>
      <div className="field">
        <label>Value (text or $&#123;parameter&#125;)</label>
        <ValueField value={condition.value} onCommit={(v) => onChange({ ...condition, value: v })} placeholder="${PARAMETER}" />
        {!condition.value && <div className="field-hint err">A value is required</div>}
      </div>
      <div className="field">
        <label>Operator</label>
        <select className="select" value={condition.operator} onChange={(e) => onChange({ ...condition, operator: e.target.value as Operator })}>
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Compare with (text or $&#123;parameter&#125;)</label>
        <ValueField value={condition.expected} onCommit={(v) => onChange({ ...condition, expected: v })} />
      </div>
    </>
  );
}

function CustomKeywordDoc({ step }: { step: CustomCallStep }) {
  const def = findCustomKeyword(useStore((s) => s.customKeywords), step);
  return (
    <>
      {def?.doc && <div className="kw-doc">{def.doc}</div>}
      <div className="muted mono kw-source">{def?.source ?? step.source}</div>
    </>
  );
}

function argHint(a: CustomKeywordArg, required: boolean): string {
  if (required) return 'required';
  if (a.default !== undefined) return `optional · default ${a.default === '' ? '(empty)' : a.default}`;
  return 'optional';
}

function CustomCallDetails({ step, upd }: { step: CustomCallStep; upd: Upd }) {
  const def = findCustomKeyword(useStore((s) => s.customKeywords), step);
  const firefox = useStore((s) => s.project?.settings.browser === 'firefox');
  const setArg = (name: string, value: string | undefined) =>
    upd((s) => {
      if (s.type !== 'customCall') return s;
      const args = { ...s.args };
      if (value === undefined) delete args[name];
      else args[name] = value;
      // follow the keyword when its file moved
      return { ...s, args, source: def?.source ?? s.source };
    });
  const toRobot = () => upd((s) => ({ id: s.id, name: s.name, type: 'raw', lines: (stepSignature(s) ?? '').split('\n') }));
  const editable = def?.args.filter((a) => a.kind === 'arg' || a.kind === 'named') ?? [];
  const known = new Set(editable.map((a) => a.name));
  const unknown = Object.keys(step.args).filter((n) => !known.has(n));
  const extra = def?.args.filter((a) => a.kind === 'varargs' || a.kind === 'kwargs') ?? [];
  return (
    <>
      {!def && (
        <div className="notice warn">
          <AlertTriangle size={14} /> "{step.keyword}" was not found in custom_keywords/. Check the file, then right-click Reusable keywords → Rescan custom keywords.
        </div>
      )}
      {def && !editable.length && !extra.length && <p className="muted">This keyword takes no arguments.</p>}
      {editable.map((a) => {
        const required = isRequired(a);
        const value = step.args[a.name];
        const clear = (v: string) => (v === '' && !required ? undefined : v);
        return (
          <div className="field" key={a.name}>
            <label className="arg-label">
              {a.name} {a.type && !a.options && <span className="badge">{a.type}</span>} <span className="muted">{argHint(a, required)}</span>
            </label>
            {a.options ? (
              <select className="select" value={value ?? ''} onChange={(e) => setArg(a.name, clear(e.target.value))}>
                {!required && <option value="">{a.default !== undefined ? `(default: ${a.default})` : '(not set)'}</option>}
                {value !== undefined && !a.options.includes(value) && <option value={value}>{value}</option>}
                {a.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <ValueField value={value ?? ''} placeholder={a.default} onCommit={(v) => setArg(a.name, clear(v))} />
            )}
            {required && !value && <div className="field-hint err">A value is required</div>}
          </div>
        );
      })}
      {unknown.map((n) => (
        <div className="field" key={n}>
          <label className="arg-label">
            {n} {def && <span className="badge warn">no longer an argument</span>}
          </label>
          <div className="row">
            <div className="grow">
              <ValueField value={step.args[n]} onCommit={(v) => setArg(n, v)} />
            </div>
            <button className="icon-btn small" title="Remove this argument" onClick={() => setArg(n, undefined)}>
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
      {extra.map((a) => (
        <div className="notice info" key={a.name}>
          {a.kind === 'varargs' ? `@{${a.name}}` : `&{${a.name}}`} takes any number of extra {a.kind === 'varargs' ? 'values' : 'name=value pairs'}. These can't be set here; convert the step to Robot code to pass them.
        </div>
      ))}
      <div className="row wrap">
        <button className="btn small" onClick={toRobot} title="Replace this step by the Robot Framework line it generates, to edit it freely">
          <Code2 size={13} /> Convert to Robot code
        </button>
      </div>
      <div className="notice info" style={{ marginTop: 12 }}>
        {firefox
          ? 'Custom keywords run with Robot Framework; with Firefox they are skipped when running inside the app.'
          : 'Custom keywords run with Robot Framework, also inside the app: Robot attaches to the browser view, which takes a few seconds per call.'}
      </div>
    </>
  );
}

function StepDetails({ step }: { step: Step }) {
  const project = useStore((s) => s.project)!;
  const upd: Upd = (fn) => updateCurrentStep(step.id, fn);
  switch (step.type) {
    case 'element':
      return <ElementDetails step={step} upd={upd} />;
    case 'wait':
      return <WaitDetails step={step} upd={upd} />;
    case 'pause':
      return (
        <>
          <div className="notice info">The test stops here until you continue: with the Continue button in the app, or by pressing a key in the terminal when the .robot file runs on its own.</div>
          <div className="field">
            <label>Message</label>
            <TextField value={step.message ?? ''} onCommit={(v) => upd((s) => ({ ...s, message: v || undefined }) as Step)} placeholder="Paused. Press any key to continue..." />
          </div>
        </>
      );
    case 'screenshot':
      return (
        <>
          <div className="field">
            <label>File name (saved in {project.settings.screenshotDir}/)</label>
            <ValueField value={step.filename} onCommit={(v) => upd((s) => ({ ...s, filename: v || 'screenshot' }) as Step)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={step.fullPage} onChange={(e) => upd((s) => ({ ...s, fullPage: e.target.checked }) as Step)} /> Full page
          </label>
        </>
      );
    case 'navigate':
      return (
        <>
          <div className="notice info">Opens this URL in the current page. Combine parameters, for example {'${URL}/orders/${ORDER_ID}'}.</div>
          <div className="field">
            <label>URL</label>
            <ValueField value={step.url} onCommit={(v) => upd((s) => ({ ...s, url: v }) as Step)} placeholder="${URL}" />
            {!step.url && <div className="field-hint err">A URL is required</div>}
          </div>
        </>
      );
    case 'if':
      return <IfDetails key={step.id} step={step} upd={upd} />;
    case 'group':
      return (
        <>
          <div className="row wrap">
            <button className="btn small" onClick={() => makeReusable(step.id)} title="Turn this group into a keyword that can be used in every test; changes apply everywhere">
              <Puzzle size={13} /> Make reusable
            </button>
            <button className="btn small" onClick={() => ungroup(step.id)}>
              <Ungroup size={13} /> Ungroup
            </button>
          </div>
          <p className="muted">{step.steps.length} step(s). Copy (Ctrl+C) and paste (Ctrl+V) the group into another test to reuse it as an independent copy.</p>
        </>
      );
    case 'keywordCall': {
      const kw = project.keywords.find((k) => k.id === step.keywordId);
      const uses = project.tests.filter((t) => [...walk(t.steps)].some(({ step: s }) => s.type === 'keywordCall' && s.keywordId === step.keywordId)).length;
      return (
        <>
          <div className="field">
            <label>Keyword</label>
            <select className="select" value={step.keywordId} onChange={(e) => upd((s) => ({ ...s, keywordId: e.target.value }) as Step)}>
              {!kw && <option value={step.keywordId}>Missing keyword</option>}
              {project.keywords.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
          {kw && <p className="muted">Linked: used in {uses} test(s). Editing the keyword changes it everywhere.</p>}
          <div className="row wrap">
            {kw && (
              <button className="btn small" onClick={() => selectContainer({ kind: 'keyword', id: kw.id })}>
                <ExternalLink size={13} /> Edit keyword
              </button>
            )}
            {kw && (
              <button className="btn small" onClick={() => unlinkKeyword(step.id)} title="Replace by an independent copy of its steps">
                <Link2Off size={13} /> Unlink (make a copy)
              </button>
            )}
          </div>
        </>
      );
    }
    case 'customCall':
      return <CustomCallDetails step={step} upd={upd} />;
    case 'raw':
      return (
        <>
          <div className="notice info">Robot Framework lines, kept exactly as written. They run with Robot Framework but are skipped when running inside the app.</div>
          <RawEditor step={step} />
        </>
      );
  }
}

function RawEditor({ step }: { step: Extract<Step, { type: 'raw' }> }) {
  const [text, setText] = useState(step.lines.join('\n'));
  useEffect(() => setText(step.lines.join('\n')), [step.lines]);
  return (
    <textarea
      className="textarea"
      rows={8}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => updateCurrentStep(step.id, (s) => ({ ...s, lines: text.split('\n').filter((l) => l.trim()) }) as Step)}
    />
  );
}

export function DetailsPanel() {
  const project = useStore((s) => s.project);
  const current = useStore((s) => s.current);
  const detail = useStore((s) => s.detail);
  const selected = useStore((s) => s.selected);
  const state = useStore((s) => (s.detail ? s.run.steps[s.detail] : undefined));
  const step = detail ? findStep(containerSteps(project, current), detail) : undefined;
  if (!project || !step) return null;
  return (
    <>
      <div className="column-header">
        <span className="title">{stepMeta(step).label} details</span>
        {selected.length > 1 && <span className="badge">{selected.length} selected</span>}
        <button className="icon-btn" title="Close details and deselect (Esc)" onClick={clearSelection}>
          <X size={16} />
        </button>
      </div>
      <div className="column-body details">
        <ParamList />
        <h3>
          <TypeIcon step={step} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{describeStep(step, project.keywords)}</span>
        </h3>
        {step.type === 'customCall' && <CustomKeywordDoc step={step} />}
        {state?.status === 'fail' && state.message && (
          <div className="notice err">
            <AlertTriangle size={14} /> {state.message}
          </div>
        )}
        <div className="field">
          <label>Name {step.type !== 'group' && <span className="muted">(optional)</span>}</label>
          <TextField value={step.name} onCommit={(v) => updateCurrentStep(step.id, (s) => ({ ...s, name: v }))} placeholder={step.type === 'group' ? 'Group name' : describeStep({ ...step, name: '' }, project.keywords)} />
        </div>
        <StepDetails step={step} />
      </div>
    </>
  );
}
