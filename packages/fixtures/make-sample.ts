/** Create a sample Joule project for the fixture site. Usage: tsx make-sample.ts <dir> [port] */
import { resolve } from 'node:path';
import { newProject, Project, type ElementDescriptor, type Step } from '@joule/core';
import { saveProject } from '@joule/core/node';

const dir = resolve(process.argv[2] ?? 'sample-project');
const port = Number(process.argv[3] ?? 4400);
const d = (tag: string, attributes: Record<string, string>, extra: Partial<ElementDescriptor> = {}): ElementDescriptor => ({ tag, classes: [], attributes, ...extra });
const el = (id: string, props: ElementDescriptor, use: string[], rest: object): Step => ({ id, name: '', type: 'element', mode: 'action', locator: { props, use }, ...rest }) as Step;

const p = newProject('Fixture shop', `http://127.0.0.1:${port}/`);
p.settings.browser = 'msedge';
p.parameters.push({ name: 'USERNAME', values: { default: 'alice', PROD: 'carol' } }, { name: 'PASSWORD', values: { default: 'secret' } });
p.keywords.push({
  id: 'kw-login',
  name: 'Log in',
  steps: [
    el('s-user', d('input', { 'data-testid': 'username', type: 'text', placeholder: 'Your username' }, { id: 'username' }), ['tag', 'attr:data-testid'], { action: { kind: 'fill', value: '${USERNAME}' } }),
    el('s-pass', d('input', { 'data-testid': 'password', type: 'password' }, { id: 'password' }), ['tag', 'attr:data-testid'], { action: { kind: 'fill', value: '${PASSWORD}' } }),
    el('s-btn', d('button', { 'data-testid': 'login', type: 'submit' }, { text: 'Log in' }), ['tag', 'attr:data-testid'], { action: { kind: 'click' } }),
    { id: 's-load', name: '', type: 'wait', wait: { kind: 'load', state: 'load' } },
  ],
});
p.tests[0] = {
  ...p.tests[0],
  id: 't-login',
  name: 'Login',
  kind: 'smoke',
  steps: [
    { id: 's-call', name: '', type: 'keywordCall', keywordId: 'kw-login' },
    {
      id: 's-welcome',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('h1', {}, { id: 'welcome', text: 'Welcome alice' }), use: ['tag', 'id'] },
      assertion: { property: 'text', operator: '==', expected: 'Welcome ${USERNAME}' },
    },
  ],
};
p.tests.push({
  id: 't-items',
  name: 'Delete an item',
  flow: 'happy',
  kind: 'regression',
  parameters: [],
  steps: [
    { id: 's-call2', name: '', type: 'keywordCall', keywordId: 'kw-login' },
    el('s-add', d('button', {}, { id: 'add', text: 'Add item', classes: ['btn'] }), ['tag', 'id'], { action: { kind: 'click' } }),
    {
      id: 's-count',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('button', {}, { classes: ['btn', 'delete'], text: 'Delete' }), use: ['tag', 'class:delete'] },
      assertion: { property: 'count', operator: '==', expected: '3' },
    },
    { id: 's-shot', name: '', type: 'screenshot', filename: 'items', fullPage: false },
  ],
});
p.tests.push({
  id: 't-wrong',
  name: 'Wrong password',
  flow: 'unhappy',
  kind: 'regression',
  parameters: [{ name: 'PASSWORD', values: { default: 'nope' } }],
  steps: [
    { id: 's-call3', name: '', type: 'keywordCall', keywordId: 'kw-login' },
    {
      id: 's-err',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('p', { role: 'alert' }, { classes: ['error'] }), use: ['attr:role'] },
      assertion: { property: 'text', operator: '==', expected: 'Wrong password' },
    },
  ],
});
p.settings.runPlan = [{ tests: ['t-login', 't-wrong'] }, { tests: ['t-items'] }];

await saveProject(dir, Project.parse(p));
console.log(`Sample project written to ${dir} (fixture site expected on port ${port})`);
