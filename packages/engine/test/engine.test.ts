import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newProject, Project, type ElementDescriptor, type Step } from '@uitester/core';
import { saveProject } from '@uitester/core/node';
import { BrowserSession, checkDeps, LiveRunner, RobotRun, type StepEvent } from '../src';
import { serveFixtures } from '../../fixtures/serve';

const PORT = 4411;
const URL = `http://127.0.0.1:${PORT}/`;
let server: Server;
const session = new BrowserSession();

beforeAll(async () => {
  server = await serveFixtures(PORT);
  await session.start({ browser: 'msedge', width: 1000, height: 700 }, URL);
}, 60_000);

afterAll(async () => {
  await session.stop();
  server.close();
});

const d = (tag: string, attributes: Record<string, string>, extra: Partial<ElementDescriptor> = {}): ElementDescriptor => ({
  tag,
  classes: [],
  attributes,
  ...extra,
});

function loginSteps(): Step[] {
  return [
    { id: 'u', name: '', type: 'element', mode: 'action', locator: { props: d('input', { 'data-testid': 'username' }), use: ['attr:data-testid'] }, action: { kind: 'fill', value: '${USERNAME}' } },
    { id: 'p', name: '', type: 'element', mode: 'action', locator: { props: d('input', { 'data-testid': 'password' }), use: ['attr:data-testid'] }, action: { kind: 'fill', value: 'secret' } },
    { id: 'c', name: '', type: 'element', mode: 'action', locator: { props: d('button', { 'data-testid': 'login' }), use: ['attr:data-testid'] }, action: { kind: 'click' } },
    { id: 'w', name: '', type: 'wait', wait: { kind: 'load', state: 'load' } },
    {
      id: 'a',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('h1', {}, { id: 'welcome' }), use: ['tag', 'id'] },
      assertion: { property: 'text', operator: '==', expected: 'Welcome ${USERNAME}' },
    },
    {
      id: 'if',
      name: '',
      type: 'if',
      condition: { locator: { props: d('button', {}, { classes: ['delete'] }), use: ['class:delete'] }, assertion: { property: 'count', operator: '>=', expected: '2' } },
      then: [
        { id: 'sel', name: '', type: 'element', mode: 'action', locator: { props: d('select', {}, { id: 'size' }), use: ['id'] }, action: { kind: 'select', value: 'Large' } },
      ],
      else: [{ id: 'never', name: '', type: 'element', mode: 'action', locator: { props: d('div', {}), use: [], custom: 'css=#does-not-exist' }, action: { kind: 'click' } }],
    },
    {
      id: 'a2',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('p', {}, { id: 'status' }), use: ['id'] },
      assertion: { property: 'text', operator: '==', expected: 'Size Large' },
    },
    { id: 'shot', name: '', type: 'screenshot', filename: 'dashboard', fullPage: false },
  ];
}

describe('browser session', () => {
  it('streams frames and turns record-mode clicks into picks', async () => {
    const frame = new Promise((r) => session.once('frame', r));
    await session.page!.evaluate(() => document.body.offsetHeight); // nudge a paint
    await session.reload();
    expect(await frame).toMatchObject({ width: 1000, height: 700 });

    await session.setMode('record');
    const box = await session.page!.locator('#username').boundingBox();
    const pick = new Promise<ElementDescriptor>((r) => session.once('pick', r));
    await session.mouse({ type: 'down', x: box!.x + 5, y: box!.y + 5, button: 'left', clickCount: 1 });
    await session.mouse({ type: 'up', x: box!.x + 5, y: box!.y + 5, button: 'left', clickCount: 1 });
    const picked = await pick;
    expect(picked).toMatchObject({ tag: 'input', id: 'username', attributes: { 'data-testid': 'username', type: 'text' } });
    expect(picked.cssPath).toBe('#username');
    await session.setMode('interact');
  });

  it('counts selector matches', async () => {
    expect(await session.count('css=input')).toBe(3);
    expect(await session.count('css=:text-is("Log in")')).toBe(1);
    expect(await session.count('css=[[bad')).toMatchObject({ error: expect.any(String) });
    await session.setHighlights([{ n: 1, selector: 'css=input', kind: 'selected', all: true }]);
  });
});

describe('live runner', () => {
  it('runs login → dashboard with params, if and assertions', async () => {
    await session.navigate(URL);
    const events: StepEvent[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'uitester-live-'));
    const ok = await new LiveRunner({
      page: session.page!,
      steps: loginSteps(),
      keywords: [],
      params: { USERNAME: 'alice' },
      timeoutSeconds: 5,
      projectDir: dir,
      screenshotDir: 'screenshots',
      signal: new AbortController().signal,
      onStep: (e) => events.push(e),
      onPause: async () => {},
    }).run();
    const failed = events.filter((e) => e.status === 'fail');
    expect(failed).toEqual([]);
    expect(ok).toBe(true);
    expect(events.filter((e) => e.status === 'pass').map((e) => e.id)).toEqual(['u', 'p', 'c', 'w', 'a', 'sel', 'if', 'a2', 'shot']);
  }, 30_000);

  it('reports the failing step and stops', async () => {
    await session.navigate(URL);
    const events: StepEvent[] = [];
    const steps = loginSteps();
    (steps[1] as Extract<Step, { type: 'element' }>).action = { kind: 'fill', value: 'wrong' };
    const ok = await new LiveRunner({
      page: session.page!,
      steps,
      keywords: [],
      params: { USERNAME: 'bob' },
      timeoutSeconds: 2,
      projectDir: tmpdir(),
      screenshotDir: 'screenshots',
      signal: new AbortController().signal,
      onStep: (e) => events.push(e),
      onPause: async () => {},
    }).run();
    expect(ok).toBe(false);
    const fail = events.find((e) => e.status === 'fail');
    expect(fail?.id).toBe('a');
  }, 30_000);
});

describe('robot runner', async () => {
  const deps = await checkDeps(process.cwd());
  it.runIf(deps.ok)('runs the generated suite with Robot Framework', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uitester-robot-'));
    const p = newProject('Fixture', URL);
    p.settings.browser = 'msedge';
    p.parameters.push({ name: 'USERNAME', values: { default: 'alice', PROD: 'carol' } });
    p.tests[0].steps = loginSteps();
    const second = { ...structuredClone(p.tests[0]), id: 't2', name: 'login as prod user' };
    p.tests.push(second);
    p.settings.runPlan = [{ tests: [p.tests[0].id, 't2'] }];
    const saved = await saveProject(dir, Project.parse(p));
    const lines: string[] = [];
    const result = await new RobotRun({
      projectDir: dir,
      project: saved,
      python: deps.python!.path,
      env: 'TEST',
      headless: true,
      parallel: !!deps.pabot,
      onLine: (l) => lines.push(l),
      onPause: () => {},
    }).run();
    if (!result.ok) console.log(lines.join('\n'));
    expect(result.results.map((r) => [r.testId, r.status])).toEqual(
      expect.arrayContaining([[p.tests[0].id, 'PASS'], ['t2', 'PASS']]),
    );
    expect(result.ok).toBe(true);
  }, 180_000);
});
