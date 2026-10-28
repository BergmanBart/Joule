import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProject, Project, type Step } from '@uitester/core';
import { externallyEdited, saveProject } from '@uitester/core/node';
import { findPython, importFolder } from '../src';

const python = await findPython(process.cwd());
const btn = { tag: 'button', id: 'go', classes: ['x'], attributes: { type: 'submit' }, text: 'Go' };

function project(): Project {
  const p = newProject('RoundTrip', 'https://example.com');
  p.parameters.push({ name: 'USER', values: { default: 'alice', PROD: 'carol' } });
  p.keywords.push({
    id: 'kw1',
    name: 'Login',
    steps: [
      { id: 'k1', name: '', type: 'element', mode: 'action', locator: { props: btn, use: ['tag', 'id'] }, action: { kind: 'fill', value: '${USER}' } },
      { id: 'kg', name: 'Inner', type: 'group', collapsed: false, steps: [{ id: 'k2', name: '', type: 'pause' }] },
    ],
  });
  const t = p.tests[0];
  t.id = 't1';
  t.flow = 'unhappy';
  t.kind = 'smoke';
  t.parameters = [{ name: 'USER', values: { default: 'bob' } }];
  t.steps = [
    { id: 'c1', name: '', type: 'keywordCall', keywordId: 'kw1' },
    {
      id: 'g1',
      name: 'Form',
      type: 'group',
      collapsed: false,
      steps: [
        { id: 's1', name: '', type: 'element', mode: 'action', locator: { props: btn, use: ['text'] }, action: { kind: 'dblclick' } },
        { id: 's2', name: '', type: 'element', mode: 'action', locator: { props: btn, use: ['tag'] }, action: { kind: 'select', value: 'Large  one' } },
      ],
    },
    {
      id: 'if1',
      name: '',
      type: 'if',
      condition: { locator: { props: btn, use: ['id'] }, assertion: { property: 'count', operator: '>=', expected: '1' } },
      then: [{ id: 'w1', name: '', type: 'wait', wait: { kind: 'element', locator: { props: btn, use: ['tag'] }, state: 'visible', timeoutSeconds: 3 } }],
      else: [{ id: 'w2', name: '', type: 'wait', wait: { kind: 'load', state: 'networkidle' } }],
    },
    { id: 'sh', name: '', type: 'screenshot', filename: 'end', fullPage: true },
    { id: 'a1', name: '', type: 'element', mode: 'assert', locator: { props: btn, use: ['tag'] }, assertion: { property: 'state', operator: '!=', expected: 'disabled' } },
  ];
  return Project.parse(p);
}

describe.runIf(python)('robot import', () => {
  it('round-trips a UITester project through its .robot files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uitester-import-'));
    const saved = await saveProject(dir, project());
    const { project: back, warnings } = await importFolder(dir, python!, saved);
    expect(warnings).toEqual([]);
    expect(back.tests).toEqual(saved.tests);
    expect(back.keywords).toEqual(saved.keywords);
    expect(back.parameters).toEqual(saved.parameters);
  });

  it('detects hand edits and keeps unchanged steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uitester-edit-'));
    const saved = await saveProject(dir, project());
    const file = join(dir, 'tests', 'Test1.robot');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('    Take Screenshot', '    Log    hand written\n    Take Screenshot'));
    expect(await externallyEdited(dir, saved)).toEqual(['tests/Test1.robot']);
    const { project: back } = await importFolder(dir, python!, saved);
    const ids = back.tests[0].steps.map((s) => s.id);
    expect(ids.filter((id) => saved.tests[0].steps.some((s) => s.id === id))).toEqual(['c1', 'g1', 'if1', 'sh', 'a1']);
    const raw = back.tests[0].steps.find((s): s is Extract<Step, { type: 'raw' }> => s.type === 'raw');
    expect(raw?.lines).toEqual(['Log    hand written']);
  });

  it('opens a plain Robot suite that UITester did not create', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uitester-foreign-'));
    await mkdir(join(dir, 'suites'));
    await writeFile(
      join(dir, 'suites', 'shop.robot'),
      [
        '*** Settings ***',
        'Library    Browser',
        '',
        '*** Variables ***',
        '${USER}    dave',
        '',
        '*** Test Cases ***',
        'Buy Something',
        '    [Tags]    smoke',
        '    New Page    https://shop.example',
        '    Fill Text    id=user    ${USER}',
        '    Click    text=Buy',
        '    Get Text    h1    ==    Thanks',
        '    FOR    ${i}    IN RANGE    3',
        '        Log    ${i}',
        '    END',
        '    Do The Thing',
        '',
        '*** Keywords ***',
        'Do The Thing',
        '    Sleep    1s',
        '',
      ].join('\n'),
    );
    const { project: p, warnings } = await importFolder(dir, python!);
    expect(p.parameters.find((x) => x.name === 'URL')?.values.default).toBe('https://shop.example');
    expect(warnings.some((w) => w.includes('New Page'))).toBe(true);
    const t = p.tests[0];
    expect(t).toMatchObject({ name: 'Buy Something', kind: 'smoke', parameters: [{ name: 'USER', values: { default: 'dave' } }] });
    expect(t.steps.map((s) => s.type)).toEqual(['raw', 'element', 'element', 'element', 'raw', 'group']);
    expect(t.steps[1]).toMatchObject({ action: { kind: 'fill', value: '${USER}' }, locator: { custom: 'id=user' } });
    expect(t.steps[3]).toMatchObject({ mode: 'assert', assertion: { property: 'text', operator: '==', expected: 'Thanks' } });
    expect(t.steps[5]).toMatchObject({ type: 'group', name: 'Do The Thing', steps: [{ type: 'wait', wait: { kind: 'time', seconds: 1 } }] });
  });
});
