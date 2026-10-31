import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSelector, defaultHasUse, defaultScopeUse, defaultUse, newProject, Project, type ElementDescriptor, type Step } from '@joule/core';
import { saveProject } from '@joule/core/node';
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
    {
      id: 'del',
      name: '',
      type: 'element',
      mode: 'action',
      locator: {
        props: d('button', {}, { text: 'Delete' }),
        use: ['tag', 'text'],
        within: { parent: { props: d('li', {}), use: ['tag'] }, has: [{ props: d('span', {}, { text: 'Pear' }), use: ['tag', 'text'] }] },
      },
      action: { kind: 'click' },
    },
    {
      id: 'left',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: d('span', {}, { classes: ['name'] }), use: ['class:name'] },
      assertion: { property: 'text', operator: '==', expected: 'Apple' },
    },
    { id: 'shot', name: '', type: 'screenshot', filename: 'dashboard', fullPage: false },
    { id: 'nav', name: '', type: 'navigate', url: '${URL}shadow.html?user=${USERNAME}' },
    { id: 'basket', name: '', type: 'element', mode: 'assert', locator: { props: d('h1', {}, { id: 'title' }), use: ['id'] }, assertion: { property: 'text', operator: '==', expected: 'Basket' } },
  ];
}

/** Pear's Delete button inside nested open shadow roots, found via "must be inside" a row that contains "Pear". */
function shadowSteps(): Step[] {
  return [
    {
      id: 'sd',
      name: '',
      type: 'element',
      mode: 'action',
      locator: {
        props: d('button', {}, { classes: ['btn', 'delete'], text: 'Delete' }),
        use: ['tag', 'text'],
        within: { parent: { props: d('div', {}, { classes: ['row'] }), use: ['tag', 'class:row'] }, has: [{ props: d('span', {}, { text: 'Pear' }), use: ['tag', 'text'] }] },
      },
      action: { kind: 'click' },
    },
    { id: 'ss', name: '', type: 'element', mode: 'assert', locator: { props: d('p', {}, { id: 'status' }), use: ['id'] }, assertion: { property: 'text', operator: '==', expected: 'Deleted Pear' } },
    { id: 'sc', name: '', type: 'element', mode: 'assert', locator: { props: d('fruit-row', {}), use: ['tag'] }, assertion: { property: 'count', operator: '==', expected: '1' } },
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

  it('streams no frames while the page and its outlines are still', async () => {
    let frames = 0;
    const count = () => frames++;
    session.on('frame', count);
    await session.setHighlights([
      { n: 1, selector: 'css=input', kind: 'selected', all: true },
      { n: 2, selector: 'css=button', kind: 'normal' },
      { n: 3, selector: 'css=[[bad', kind: 'normal' },
    ]);
    await expect.poll(() => frames, { timeout: 3000 }).toBeGreaterThan(0); // the new outline is drawn
    await session.page!.waitForTimeout(500);
    frames = 0;
    // outlines that kept following the page used to repaint it, and so stream a frame, every animation frame
    await session.page!.waitForTimeout(1000);
    session.off('frame', count);
    expect(frames).toBeLessThan(3);
  });

  it('pauses the frame stream and resumes with the current page', async () => {
    await session.setStreaming(false);
    let frames = 0;
    const count = () => frames++;
    session.on('frame', count);
    await session.page!.evaluate(() => (document.body.style.background = 'rgb(200, 0, 0)'));
    await session.page!.waitForTimeout(500);
    expect(frames).toBe(0);
    const frame = new Promise((r) => session.once('frame', r));
    await session.setStreaming(true);
    await frame;
    session.off('frame', count);
    await session.page!.evaluate(() => (document.body.style.background = ''));
  });

  it('resolves must-be-inside selectors and limits scope picks', async () => {
    await session.navigate(URL + 'dashboard.html');
    expect(await session.count('css=button:text-is("Delete")')).toBe(2);
    expect(await session.count('css=li:has(span:text-is("Pear")) >> css=button:text-is("Delete")')).toBe(1);
    expect(await session.count('xpath=//li >> internal:has="css=span:text-is(\\"Pear\\")" >> css=button')).toBe(1);
    expect(await session.describeParent('css=span:text-is("Pear")')).toMatchObject({ tag: 'li' });

    const clickPick = async (selector: string) => {
      const box = (await session.page!.locator(selector).boundingBox())!;
      const pick = new Promise<ElementDescriptor>((r) => session.once('pick', r));
      await session.mouse({ type: 'down', x: box.x + 3, y: box.y + 3, button: 'left', clickCount: 1 });
      await session.mouse({ type: 'up', x: box.x + 3, y: box.y + 3, button: 'left', clickCount: 1 });
      return Promise.race([pick, new Promise<undefined>((r) => setTimeout(r, 500))]);
    };
    await session.setMode('record');
    // parent pick: the name is not an ancestor of a Delete button, its row is
    expect(await session.setPickConstraint({ selector: 'css=button.delete', relation: 'ancestor' })).toEqual({ found: true });
    expect(await clickPick('css=span:text-is("Pear")')).toMatchObject({ tag: 'li' });
    // contains pick: only inside a row
    await session.setPickConstraint({ selector: 'css=li', relation: 'descendant' });
    expect(await clickPick('css=span:text-is("Pear")')).toMatchObject({ tag: 'span', text: 'Pear' });
    expect(await clickPick('#welcome')).toBeUndefined();
    expect(await session.setPickConstraint({ selector: 'css=#nope', relation: 'ancestor' })).toEqual({ found: false });
    await session.setPickConstraint(null);
    await session.setMode('interact');
    await session.navigate(URL);
  });

  it('records, scopes and outlines elements inside (nested) shadow roots', async () => {
    await session.navigate(URL + 'shadow.html');
    const clickPick = async (selector: string) => {
      const box = (await session.page!.locator(selector).first().boundingBox())!;
      const pick = new Promise<ElementDescriptor>((r) => session.once('pick', r));
      await session.mouse({ type: 'down', x: box.x + 3, y: box.y + 3, button: 'left', clickCount: 1 });
      await session.mouse({ type: 'up', x: box.x + 3, y: box.y + 3, button: 'left', clickCount: 1 });
      return Promise.race([pick, new Promise<undefined>((r) => setTimeout(r, 500))]);
    };
    await session.setMode('record');
    // the button itself, not the outer <fruit-list> host the event is retargeted to
    const del = await clickPick('fruit-row[name=Pear] >> button.delete');
    expect(del).toMatchObject({ tag: 'button', classes: ['btn', 'delete'], text: 'Delete', xpath: undefined });
    expect(await session.count(`css=${del!.cssPath}`)).toBe(1);
    expect(await session.count(buildSelector({ props: del!, use: defaultUse(del!) }))).toBe(2);

    // must be inside: the row div in the row's shadow root, then its host
    await session.setPickConstraint({ selector: 'css=button:text-is("Delete")', relation: 'ancestor' });
    const row = await clickPick('fruit-row[name=Pear] >> span.name');
    expect(row).toMatchObject({ tag: 'div', classes: ['row'] });
    expect(await session.describeParent('css=fruit-row[name=Pear] div.row')).toMatchObject({ tag: 'fruit-row', attributes: { name: 'Pear' } });
    // parent also contains: inside a row
    await session.setPickConstraint({ selector: 'css=div.row', relation: 'descendant' });
    const name = await clickPick('fruit-row[name=Pear] >> span.name');
    expect(name).toMatchObject({ tag: 'span', text: 'Pear' });
    const within = { parent: { props: row!, use: defaultScopeUse(row!) }, has: [{ props: name!, use: defaultHasUse(name!) }] };
    expect(await session.count(buildSelector({ props: del!, use: defaultUse(del!), within }))).toBe(1);
    await session.setPickConstraint(null);

    // closed shadow root: only the host is reachable
    expect(await clickPick('secret-box')).toMatchObject({ tag: 'secret-box' });
    await session.setMode('interact');

    // changes inside a shadow root re-resolve the outlines
    let refreshed = 0;
    const refresh = session.refresh.bind(session);
    session.refresh = async () => (refreshed++, refresh());
    await session.page!.locator('fruit-list #add').click();
    await expect.poll(() => refreshed, { timeout: 3000 }).toBeGreaterThan(0);
    session.refresh = refresh;
    await session.navigate(URL);
  });
});

describe('reset', () => {
  it('starts over without cookies or storage', async () => {
    await session.navigate(URL);
    await session.page!.evaluate(() => {
      document.cookie = 'token=abc';
      localStorage.setItem('k', 'v');
    });
    await session.reset(URL);
    expect(session.page!.url()).toBe(URL);
    expect(await session.page!.evaluate(() => [document.cookie, localStorage.getItem('k')])).toEqual(['', null]);
    // the overlay is injected into the new context too
    expect(await session.page!.evaluate(() => typeof (window as any).__joule)).toBe('object');
  });
});

describe('live runner', () => {
  it('runs login → dashboard with params, if and assertions', async () => {
    await session.navigate(URL);
    const events: StepEvent[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'joule-live-'));
    const ok = await new LiveRunner({
      page: session.page!,
      steps: loginSteps(),
      keywords: [],
      params: { URL, USERNAME: 'alice' },
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
    expect(events.filter((e) => e.status === 'pass').map((e) => e.id)).toEqual(['u', 'p', 'c', 'w', 'a', 'sel', 'if', 'a2', 'del', 'left', 'shot', 'nav', 'basket']);
    expect(session.page!.url()).toBe(`${URL}shadow.html?user=alice`);
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
    const dir = await mkdtemp(join(tmpdir(), 'joule-robot-'));
    const p = newProject('Fixture', URL);
    p.settings.browser = 'msedge';
    p.parameters.push({ name: 'USERNAME', values: { default: 'alice', PROD: 'carol' } });
    p.parameters.push({ name: 'RUN_ID', kind: 'random', values: { default: '[a-z]{6}' } });
    p.parameters.push({ name: 'RUN_DATE', kind: 'date', values: { default: 'today + 1wd' } });
    p.tests[0].steps = loginSteps();
    const second = { ...structuredClone(p.tests[0]), id: 't2', name: 'login as prod user' };
    p.tests.push(second);
    p.tests.push({
      id: 't3',
      name: 'delete inside shadow roots',
      flow: 'happy',
      kind: 'regression',
      // a random case id and a due date in the start URL, set by the generated suite setup
      parameters: [
        { name: 'CASE', kind: 'random', values: { default: '[A-Z]{5}' } },
        { name: 'DUE', kind: 'date', format: 'yyyy-MM-dd', values: { default: 'today + 1m' } },
        { name: 'URL', values: { default: URL + 'shadow.html?case=${CASE}&run=${RUN_ID}&due=${DUE}&from=${RUN_DATE}' } },
      ],
      steps: shadowSteps(),
    });
    p.settings.runPlan = [{ tests: [p.tests[0].id, 't2', 't3'] }];
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
      expect.arrayContaining([[p.tests[0].id, 'PASS'], ['t2', 'PASS'], ['t3', 'PASS']]),
    );
    expect(result.ok).toBe(true);
  }, 180_000);

  it.runIf(deps.ok)('pauses a Robot run until the app says continue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-pause-'));
    const p = newProject('Pause', URL);
    p.settings.browser = 'msedge';
    p.tests[0].steps = [{ id: 'pz', name: '', type: 'pause', message: 'Check the page' }];
    const saved = await saveProject(dir, Project.parse(p));
    let paused = '';
    const run: RobotRun = new RobotRun({
      projectDir: dir,
      project: saved,
      python: deps.python!.path,
      env: 'TEST',
      headless: true,
      parallel: false,
      onLine: () => {},
      onPause: (m) => {
        paused = m;
        setTimeout(() => run.continue(), 300);
      },
    });
    const result = await run.run();
    expect(paused).toBe('Check the page');
    expect(result.ok).toBe(true);
  }, 120_000);
});
