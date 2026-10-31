import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dateFromExpression, newProject, Project, type Step } from '@joule/core';
import { externallyEdited, saveProject } from '@joule/core/node';
import { findPython, importFolder, scanCustomKeywords } from '../src';

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
  it('round-trips a Joule project through its .robot files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-import-'));
    const saved = await saveProject(dir, project());
    const { project: back, warnings } = await importFolder(dir, python!, saved);
    expect(warnings).toEqual([]);
    expect(back.tests).toEqual(saved.tests);
    expect(back.keywords).toEqual(saved.keywords);
    expect(back.parameters).toEqual(saved.parameters);
  });

  function randomProject(): Project {
    const p = project();
    p.parameters[0].values.default = '${BASE}/case/${CASE_ID}';
    p.parameters.push({ name: 'BASE', values: { default: 'https://app.example', PROD: 'https://prod.example' } });
    p.parameters.push({ name: 'CASE_ID', kind: 'random', values: { default: 'C[0-9]{6}', ACC: 'A\\d{3}' } });
    p.tests[0].parameters.push({ name: 'TITLE', values: { default: 'Case ${CASE_ID} by ${NICK}' } });
    p.tests[0].parameters.push({ name: 'NICK', kind: 'random', values: { default: '(ann|bob)_[a-z]{3}' } });
    return Project.parse(p);
  }

  it('round-trips random and combined parameters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-random-'));
    const saved = await saveProject(dir, randomProject());
    const { project: back, warnings } = await importFolder(dir, python!, saved);
    expect(warnings).toEqual([]);
    expect(back.parameters).toEqual(saved.parameters);
    expect(back.tests).toEqual(saved.tests);
    // without the joule.json as well
    const { project: fresh } = await importFolder(dir, python!);
    expect(fresh.parameters.find((p) => p.name === 'CASE_ID')).toEqual(saved.parameters.find((p) => p.name === 'CASE_ID'));
    expect(fresh.parameters.find((p) => p.name === 'URL')?.values.default).toBe('${BASE}/case/${CASE_ID}');
    expect(fresh.tests[0].parameters.find((p) => p.name === 'NICK')).toMatchObject({ kind: 'random', values: { default: '(ann|bob)_[a-z]{3}' } });
  });

  it('draws matching values in the generated Python', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-py-'));
    await saveProject(dir, randomProject());
    const patterns = ['CASE-[A-Z]{3}\\d{4}', '[a-z0-9_]{5,10}', '[^a-z]{6}', '(foo|bar)-\\w+', '(?:ab)*c?', '(?P<id>[0-9]{2})x(?P=id)', '\\.\\*', 'a{2,}b+', '^\\d\\s\\D\\S\\W$', '[\\d.-]{4}', '[a]', 'x|y'];
    const script = [
      'import json, re, runpy, sys',
      'sys.path.insert(0, sys.argv[1] + "/resources")',
      'from JouleLib import random_from_regex',
      'for p in json.loads(sys.argv[2]):',
      '    for _ in range(100):',
      '        v = random_from_regex(p)',
      '        assert re.fullmatch(p, v), (p, v)',
      'env = runpy.run_path(sys.argv[1] + "/env/TEST.py")',
      'print(json.dumps({k: v for k, v in env.items() if not k.startswith("_")}))',
    ].join('\n');
    const out = await new Promise<string>((res, rej) =>
      execFile(python!, ['-c', script, dir, JSON.stringify(patterns)], (err, stdout, stderr) => (err ? rej(new Error(stderr)) : res(stdout))),
    );
    const env = JSON.parse(out);
    expect(env.CASE_ID).toMatch(/^C\d{6}$/);
    expect(env.URL).toBe(`https://app.example/case/${env.CASE_ID}`);
  });

  function dateProject(): Project {
    const p = project();
    p.parameters.push({ name: 'START', kind: 'date', values: { default: 'today + 5wd', ACC: '2026-12-25' } });
    p.parameters.push({ name: 'STAMP', kind: 'date', format: 'yyyy-MM-dd HH:mm', values: { default: 'now - 2h' } });
    p.tests[0].parameters.push({ name: 'DUE', kind: 'date', format: 'dd/MM/yyyy', values: { default: 'today + 1m' } });
    p.tests[0].parameters.push({ name: 'NOTE', values: { default: 'Due ${DUE}' } });
    return Project.parse(p);
  }

  it('round-trips date parameters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-date-'));
    const saved = await saveProject(dir, dateProject());
    const { project: back, warnings } = await importFolder(dir, python!, saved);
    expect(warnings).toEqual([]);
    expect(back.parameters).toEqual(saved.parameters);
    expect(back.tests).toEqual(saved.tests);
    // without the joule.json as well
    const { project: fresh } = await importFolder(dir, python!);
    for (const name of ['START', 'STAMP']) expect(fresh.parameters.find((p) => p.name === name)).toEqual(saved.parameters.find((p) => p.name === name));
    expect(fresh.tests[0].parameters.find((p) => p.name === 'DUE')).toEqual(saved.tests[0].parameters.find((p) => p.name === 'DUE'));
  });

  it('works out the same dates in the generated Python', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-pydate-'));
    await saveProject(dir, dateProject());
    const cases: [string, string][] = [
      ['today', 'dd-MM-yyyy'],
      ['now', 'yyyy-MM-dd HH:mm:ss'],
      ['today + 3d - 1w', 'd-M-yy'],
      ['today + 1m', 'yyyyMMdd'],
      ['TODAY + 1 Year', 'dd.MM.yyyy'],
      ['today - 13 months', 'dd-MM-yyyy'],
      ['today + 1wd', 'dd-MM-yyyy'],
      ['today - 6wd', 'dd-MM-yyyy'],
      ['today + 2 workdays', 'dd-MM-yyyy'],
      ['now + 10h - 30min', 'dd-MM-yyyy H:mm'],
      ['2026-12-25', 'dd-MM-yyyy'],
      ['25/12/2026 14:30', 'yyyy-MM-dd HH:mm'],
      ['2028.2.29', 'yyyy-MM-dd'],
    ];
    const invalid = ['', 'tomorrow', 'today + 3x', 'today +', '2026-13-01', '2026-02-30', '2026-12-25 24:00', '2026-12-25 + 1d'];
    const script = [
      'import datetime, json, sys',
      'sys.path.insert(0, sys.argv[1] + "/resources")',
      'import JouleLib',
      'JouleLib._now = lambda: datetime.datetime(2026, 1, 30, 14, 5, 9)',
      'out = [JouleLib.relative_date(e, f) for e, f in json.loads(sys.argv[2])]',
      'errors = []',
      'for e in json.loads(sys.argv[3]):',
      '    try:',
      '        JouleLib.relative_date(e)',
      '    except ValueError:',
      '        errors.append(e)',
      'print(json.dumps({"out": out, "errors": errors}))',
    ].join('\n');
    const stdout = await new Promise<string>((res, rej) =>
      execFile(python!, ['-c', script, dir, JSON.stringify(cases), JSON.stringify(invalid)], (err, out, stderr) => (err ? rej(new Error(stderr)) : res(out))),
    );
    const now = new Date(2026, 0, 30, 14, 5, 9);
    const py = JSON.parse(stdout);
    expect(py.out).toEqual(cases.map(([e, f]) => dateFromExpression(e, f, now)));
    expect(py.errors).toEqual(invalid);
  });

  it('detects hand edits and keeps unchanged steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-edit-'));
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

  it('opens a plain Robot suite that Joule did not create', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-foreign-'));
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

  it('scans custom keywords and round-trips calls to them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-custom-'));
    await mkdir(join(dir, 'custom_keywords', 'sub'), { recursive: true });
    await writeFile(
      join(dir, 'custom_keywords', 'sub', 'login.resource'),
      [
        '*** Keywords ***',
        'Login As',
        '    [Documentation]    Logs in.',
        '    ...',
        '    ...    Second paragraph.',
        "    [Arguments]    ${user}    ${mode: Literal['fast', 'slow']}=fast    ${remember: bool}=False",
        '    Log    ${user} ${mode} ${remember}',
        '',
      ].join('\n'),
    );
    const { keywords } = await scanCustomKeywords(dir, python!);
    expect(keywords).toEqual([
      {
        name: 'Login As',
        source: 'custom_keywords/sub/login.resource',
        doc: 'Logs in.\n\nSecond paragraph.',
        args: [
          { name: 'user', kind: 'arg' },
          { name: 'mode', kind: 'arg', default: 'fast', type: "Literal['fast', 'slow']", options: ['fast', 'slow'] },
          { name: 'remember', kind: 'arg', default: 'False', type: 'bool', options: ['True', 'False'] },
        ],
      },
    ]);

    const p = project();
    p.tests[0].steps.push({ id: 'cc', name: 'Sign in', type: 'customCall', keyword: 'Login As', source: keywords[0].source, args: { user: '${USER}', mode: 'slow' } });
    const saved = await saveProject(dir, Project.parse(p));
    const { project: back, warnings } = await importFolder(dir, python!, saved);
    expect(warnings).toEqual([]);
    expect(back.tests).toEqual(saved.tests);
    // the custom file is not taken over as one of Joule's own keywords
    expect(back.keywords.map((k) => k.name)).toEqual(['Login']);

    // a hand-written positional call is recognised as well
    const file = join(dir, 'tests', 'Test1.robot');
    await writeFile(file, (await readFile(file, 'utf8')).replace('    Take Screenshot', '    Login As    carol    fast\n    Take Screenshot'));
    const { project: edited } = await importFolder(dir, python!, saved);
    expect(edited.tests[0].steps.find((s) => s.type === 'customCall' && s.id !== 'cc')).toMatchObject({ keyword: 'Login As', args: { user: 'carol', mode: 'fast' } });
  });
});
