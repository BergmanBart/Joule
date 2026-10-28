/**
 * End-to-end: fixture site + UITester server + built UI, driven by a real (headless) browser.
 * Run `npm run build -w @uitester/ui` first. Set SHOTS=<dir> to keep screenshots.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newProject, Project } from '@uitester/core';
import { saveProject } from '@uitester/core/node';
import { checkDeps, launchBrowser } from '@uitester/engine';
import type { Browser, Locator, Page } from 'playwright-core';
import { serveFixtures } from '../../fixtures/serve';
import { startServer } from '../src';

const UI = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const SITE_PORT = 4412;
const APP_PORT = 4391;
const SITE = `http://127.0.0.1:${SITE_PORT}/`;
const shotsDir = process.env.SHOTS;

let site: Server;
let app: Awaited<ReturnType<typeof startServer>>;
let browser: Browser;
let page: Page;
let dir: string;

const visible = (loc: Locator, timeout = 10_000) => loc.first().waitFor({ state: 'visible', timeout });
const count = (loc: Locator, n: number, timeout = 10_000) => expect.poll(() => loc.count(), { timeout }).toBe(n);
const text = (loc: Locator, t: string | RegExp, timeout = 10_000) =>
  expect.poll(async () => (await loc.first().textContent().catch(() => null)) ?? '', { timeout }).toMatch(t);

async function shot(name: string) {
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

/** Click a point of the *tested* page through the streamed canvas. */
async function clickInView(x: number, y: number) {
  const canvas = page.locator('.viewport canvas');
  const box = (await canvas.boundingBox())!;
  const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  await page.mouse.click(box.x + (x * box.width) / size.w, box.y + (y * box.height) / size.h);
}

/** Element centre in the tested page, measured with a separate page of the same size. */
async function centre(url: string, selector: string) {
  const probe = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  await probe.goto(url);
  const b = (await probe.locator(selector).boundingBox())!;
  await probe.close();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const textToEnter = () => page.locator('.details .field', { hasText: 'Text to enter' }).locator('input.input');

describe.runIf(existsSync(join(UI, 'index.html')))('UITester app', () => {
  beforeAll(async () => {
    // the temp project has no .venv: point the app at the repo's Robot Framework install
    const deps = await checkDeps(process.cwd());
    if (deps.python) process.env.UITESTER_PYTHON = deps.python.path;
    site = await serveFixtures(SITE_PORT);
    dir = await mkdtemp(join(tmpdir(), 'uitester-ui-'));
    const p = newProject('Fixture shop', SITE);
    p.settings.browser = 'msedge';
    p.settings.width = 1000;
    p.settings.height = 640;
    p.settings.headless = true;
    p.parameters.push({ name: 'USERNAME', values: { default: 'alice', PROD: 'carol' } });
    await saveProject(dir, Project.parse(p));
    app = await startServer({ port: APP_PORT, uiDir: UI, projectDir: dir });
    browser = await launchBrowser('msedge', true);
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(app.url);
    await page.locator('.viewport canvas').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    site?.close();
  });

  it('shows the project with an empty Test1 and the live page', async () => {
    await text(page.locator('.list-item.active .name'), 'Test1');
    await visible(page.getByText('No events defined yet.'));
    await shot('01-empty');
  });

  it('records clicks in the browser view as numbered events', async () => {
    const user = await centre(SITE, '#username');
    await clickInView(user.x, user.y);
    await text(page.locator('.step-row .step-label'), /Enter text in input/);
    await visible(page.getByText('Finds exactly 1 element'));
    await textToEnter().fill('${USERNAME}');
    await textToEnter().press('Enter');
    await visible(page.locator('.details').getByText('= alice'));

    const pass = await centre(SITE, '#password');
    await clickInView(pass.x, pass.y);
    await count(page.locator('.step-row'), 2);
    await textToEnter().fill('secret');
    await textToEnter().press('Enter');

    const login = await centre(SITE, 'button[type=submit]');
    await clickInView(login.x, login.y);
    await count(page.locator('.step-row'), 3);
    await text(page.locator('.step-row .step-label').nth(2), /Click button "Log in"/);
    await page.waitForTimeout(500);
    await shot('02-recorded');
  });

  it('warns when the search properties match several elements', async () => {
    // Make the password step search by tag only: matches 3 inputs.
    await page.locator('.step-row').nth(1).click();
    const props = page.locator('.details .prop');
    const n = await props.count();
    for (let i = 0; i < n; i++) {
      const box = props.nth(i).locator('input[type=checkbox]');
      const label = await props.nth(i).locator('.k').textContent();
      if ((label === 'tag') !== (await box.isChecked())) await box.click();
    }
    await visible(page.getByText(/Finds 3 elements/));
    await page.waitForTimeout(400);
    await shot('03-multiple-matches');
    // back to the recorded (unique) selector
    for (let i = 0; i < n; i++) {
      const box = props.nth(i).locator('input[type=checkbox]');
      const label = await props.nth(i).locator('.k').textContent();
      if ((label === 'id') !== (await box.isChecked())) await box.click();
    }
    await visible(page.getByText('Finds exactly 1 element'));
  });

  it('adds a wait and groups steps', async () => {
    await page.locator('.step-row').nth(2).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Wait (time, page load, element)').click();
    await page.locator('.details').getByRole('button', { name: 'Page load' }).click();
    await count(page.locator('.step-row'), 4);

    await page.locator('.step-row').nth(0).click();
    await page.locator('.step-row').nth(1).click({ modifiers: ['Shift'] });
    page.once('dialog', (d) => void d.accept('Login form'));
    await page.locator('button[title="Group selected (Ctrl+G)"]').click();
    await text(page.locator('.step-row.group-row .step-label'), 'Login form');
    await shot('04-grouped');
  });

  it('runs the test inside the app and with Robot Framework', async () => {
    await page.locator('button[title^="Run all steps in the browser view"]').click();
    await visible(page.getByText(/In-app run: \d+ passed, 0 failed/), 20_000);
    await count(page.locator('.step-row .run-state svg'), 5); // group + 4 steps
    await shot('05-live-run');

    const deps = await checkDeps(process.cwd());
    if (!deps.ok) return;
    await page.locator('.list-item.active').hover();
    await page.locator('.list-item.active button[title="Run with Robot Framework"]').click();
    try {
      await text(page.locator('.drawer .badge.ok'), 'Test1: PASS', 120_000);
    } finally {
      await shot('06-robot-run');
    }
    const robot = await readFile(join(dir, 'tests', 'Test1.robot'), 'utf8');
    expect(robot).toContain('Login form');
    expect(robot).toContain('Fill Text    css=input[data-testid="username"]    ${USERNAME}');
  }, 180_000);

  it('opens the parameters and settings popups', async () => {
    await page.getByRole('button', { name: 'Parameters' }).first().click();
    await visible(page.getByRole('dialog', { name: 'Project parameters' }));
    await shot('07-parameters');
    await page.keyboard.press('Escape');
    await page.locator('button[title="Project settings"]').click();
    await page.getByRole('button', { name: 'Run plan', exact: true }).click();
    await shot('08-settings-runplan');
    await page.keyboard.press('Escape');
  });

  it('adds a nested if whose condition is picked in the browser view', async () => {
    await page.locator('.drawer button[title="Close"]').click().catch(() => {});
    await page.locator('.step-row').last().click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('If statement').click();
    await visible(page.getByText('Click the element for this step'));
    // we are on the dashboard after the run: pick the "Welcome alice" heading
    const h1 = await centre(`${SITE}dashboard.html?username=alice`, '#welcome');
    await clickInView(h1.x, h1.y);
    await expect.poll(() => page.getByText('Click the element for this step').count()).toBe(0);
    await visible(page.locator('.step-row.branch', { hasText: 'Then' }));
    await page.locator('.step-row.branch', { hasText: 'Then' }).locator('button').click();
    // a nested if inside the then-branch
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('If statement').click();
    await page.locator('.pick-banner button').click();
    await count(page.locator('.step-row.branch'), 4);
    await shot('09-nested-if');
  });

  it('makes a group reusable, uses it in a second test, pastes steps and continues after a pause', async () => {
    await page.locator('.step-row.group-row').click();
    await page.getByRole('button', { name: 'Make reusable' }).click();
    await visible(page.locator('.list-item', { hasText: 'Login form' }));
    await page.locator('.step-row').nth(1).click(); // click "Log in"
    await page.locator('.step-row').nth(2).click({ modifiers: ['Shift'] }); // + wait
    await page.keyboard.press('Control+c');

    await page.locator('button[title="New test"]').click();
    await text(page.locator('.list-item.active .name'), 'Test2');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.menu .item', { hasText: 'Login form' }).click();
    await count(page.locator('.step-row'), 1);
    await page.locator('.column-body[tabindex]').click({ position: { x: 10, y: 200 } });
    await page.locator('.step-row').first().click();
    await page.keyboard.press('Control+v');
    await count(page.locator('.step-row'), 3);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Pause', { exact: true }).click();
    await count(page.locator('.step-row'), 4);

    await page.locator('button[title^="Run all steps in the browser view"]').click();
    await visible(page.locator('.pause-banner'), 20_000);
    await shot('10-paused');
    await page.locator('.pause-banner button').click();
    await visible(page.getByText(/In-app run: 6 passed, 0 failed/), 20_000);
    await shot('11-test2-done');

    const resource = await expect.poll(() => readFile(join(dir, 'resources', 'keywords.resource'), 'utf8'), { timeout: 5000 }).toContain('Login form');
    void resource;
    const t2 = await readFile(join(dir, 'tests', 'Test2.robot'), 'utf8');
    expect(t2).toMatch(/\n    Login form\n    Click    css=button\[data-testid="login"\]\n    Wait For Load State    load\n    Pause For Key\n/);
  }, 90_000);
});
