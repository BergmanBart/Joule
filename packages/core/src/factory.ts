import { isRequired, type CustomKeyword } from './custom';
import { newId } from './ids';
import type { CustomCallStep, ElementDescriptor, Keyword, Locator, Project, Step, Test } from './model';
import { Project as ProjectSchema, Settings } from './model';
import { defaultUse } from './selector';

export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function newProject(name: string, url: string): Project {
  return ProjectSchema.parse({
    name,
    settings: Settings.parse({}),
    parameters: [{ name: 'URL', values: { default: url } }],
    tests: [newTest('Test1')],
  });
}

export function newTest(name: string): Test {
  return { id: newId('t'), name, flow: 'happy', kind: 'regression', parameters: [], steps: [] };
}

export function newKeyword(name: string, steps: Step[]): Keyword {
  return { id: newId('k'), name, steps };
}

/** A click step for an element just picked in the browser view. */
export function recordedStep(props: ElementDescriptor): Step {
  const isText = isTextInput(props);
  return {
    id: newId('s'),
    name: '',
    type: 'element',
    mode: 'action',
    locator: { props, use: defaultUse(props) },
    action: isText ? { kind: 'fill', value: '' } : isSelect(props) ? { kind: 'select', value: '' } : { kind: 'click' },
  };
}

export function isTextInput(d: ElementDescriptor): boolean {
  if (d.tag === 'textarea') return true;
  if (d.attributes['contenteditable'] === 'true' || d.attributes['contenteditable'] === '') return true;
  if (d.tag !== 'input') return false;
  const type = (d.attributes['type'] ?? 'text').toLowerCase();
  return ['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(type);
}

export function isSelect(d: ElementDescriptor): boolean {
  return d.tag === 'select';
}

export function isCheckable(d: ElementDescriptor): boolean {
  const type = (d.attributes['type'] ?? '').toLowerCase();
  return d.tag === 'input' && (type === 'checkbox' || type === 'radio');
}

export function newStep(type: 'wait' | 'pause' | 'screenshot' | 'navigate' | 'group' | 'if' | 'keywordCall', extra: { keywordId?: string } = {}): Step {
  const id = newId('s');
  switch (type) {
    case 'wait':
      return { id, name: '', type, wait: { kind: 'time', seconds: 1 } };
    case 'pause':
      return { id, name: '', type };
    case 'screenshot':
      return { id, name: '', type, filename: 'screenshot', fullPage: false };
    case 'navigate':
      return { id, name: '', type, url: '${URL}' };
    case 'group':
      return { id, name: 'Group', type, collapsed: false, steps: [] };
    case 'if':
      return {
        id,
        name: '',
        type,
        condition: {
          locator: { props: { tag: 'body', classes: [], attributes: {} }, use: ['tag'] },
          assertion: { property: 'state', operator: '==', expected: 'visible' },
        },
        then: [],
        else: [],
      };
    case 'keywordCall':
      return { id, name: '', type, keywordId: extra.keywordId ?? '' };
  }
}

/** A call of a custom keyword; required arguments start empty (or on their first option). */
export function newCustomCall(def: CustomKeyword): CustomCallStep {
  const args: Record<string, string> = {};
  for (const a of def.args) if (isRequired(a)) args[a.name] = a.options?.[0] ?? '';
  return { id: newId('s'), name: '', type: 'customCall', keyword: def.name, source: def.source, args };
}

function elementLabel(d: ElementDescriptor): string {
  const text = d.text?.trim();
  const hint = text || d.attributes['aria-label'] || d.attributes['placeholder'] || d.attributes['name'] || d.id || d.classes[0] || '';
  const short = hint.length > 30 ? `${hint.slice(0, 29)}…` : hint;
  return short ? `${d.tag} "${short}"` : d.tag;
}

function locatorLabel(loc: Locator): string {
  const el = elementLabel(loc.props);
  return loc.within ? `${el} in ${elementLabel(loc.within.parent.props)}` : el;
}

const ACTION_LABEL: Record<string, string> = {
  click: 'Click',
  dblclick: 'Double click',
  rightclick: 'Right click',
  fill: 'Enter text in',
  hover: 'Hover',
  select: 'Select in',
  check: 'Check',
  uncheck: 'Uncheck',
  press: 'Press key on',
};

/** Human readable label; the user-given name wins when set. */
export function describeStep(step: Step, keywords: Keyword[] = []): string {
  if (step.name) return step.name;
  switch (step.type) {
    case 'element': {
      const el = locatorLabel(step.locator);
      if (step.mode === 'assert') {
        const a = step.assertion;
        if (!a) return `Assert ${el}`;
        const prop = a.property === 'attribute' ? `@${a.name ?? ''}` : a.property;
        return `Assert ${el} ${prop} ${a.operator} ${a.expected}`;
      }
      const kind = step.action?.kind ?? 'click';
      const value = step.action?.value ? ` = ${step.action.value}` : '';
      return `${ACTION_LABEL[kind]} ${el}${value}`;
    }
    case 'wait':
      if (step.wait.kind === 'time') return `Wait ${step.wait.seconds}s`;
      if (step.wait.kind === 'load') return `Wait for page ${step.wait.state}`;
      return `Wait for ${locatorLabel(step.wait.locator)} ${step.wait.state}`;
    case 'pause':
      return 'Pause';
    case 'screenshot':
      return `Screenshot ${step.filename}`;
    case 'navigate':
      return `Go to ${step.url}`;
    case 'group':
      return 'Group';
    case 'if': {
      const a = step.condition.assertion;
      return `If ${locatorLabel(step.condition.locator)} ${a.property} ${a.operator} ${a.expected}`;
    }
    case 'keywordCall':
      return keywords.find((k) => k.id === step.keywordId)?.name ?? 'Missing keyword';
    case 'customCall': {
      const args = Object.entries(step.args).map(([k, v]) => `${k}=${v}`).join(', ');
      const short = args.length > 40 ? `${args.slice(0, 39)}…` : args;
      return short ? `${step.keyword} (${short})` : step.keyword;
    }
    case 'raw':
      return step.lines[0]?.trim() ?? 'Raw';
  }
}
