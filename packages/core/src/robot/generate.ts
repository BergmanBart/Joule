import { ENVIRONMENTS } from '../model';
import type { Assertion, ElementStep, Keyword, Locator, Project, Settings, Step, Test } from '../model';
import { PARAM_NAME } from '../factory';
import { parameterValue } from '../params';
import { buildSelector } from '../selector';
import { arg, fileName, robotName, row, suiteNameFromFile } from './escape';

const IND = '    ';

/** Keywords the generated code calls; user group names must not shadow them. */
const RESERVED = new Set(
  [
    'Click', 'Click With Options', 'Fill Text', 'Hover', 'Select Options By', 'Check Checkbox', 'Uncheck Checkbox',
    'Press Keys', 'Get Text', 'Get Property', 'Get Attribute', 'Get Element Count', 'Get Element States', 'Sleep',
    'Wait For Load State', 'Wait For Elements State', 'Take Screenshot', 'Pause For Key', 'New Page', 'New Browser',
    'New Context', 'Close Browser', 'Open UITester Browser', 'Run Keyword And Return Status', 'Set Browser Timeout', 'Log',
  ].map(normalize),
);

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_]/g, '');
}

/** Hands out unique keyword names within one robot file. */
class KeywordNamer {
  private used = new Set<string>(RESERVED);
  constructor(reserved: string[] = []) {
    for (const r of reserved) this.used.add(normalize(r));
  }
  take(wanted: string): string {
    let base = robotName(wanted);
    if (this.used.has(normalize(base))) base = `${base} Steps`;
    let name = base;
    for (let i = 2; this.used.has(normalize(name)); i++) name = `${base} ${i}`;
    this.used.add(normalize(name));
    return name;
  }
}

interface Ctx {
  keywords: Keyword[];
  keywordNames: Map<string, string>;
  namer: KeywordNamer;
  /** Local keyword definitions collected from groups, emitted in *** Keywords ***. */
  local: { name: string; doc: string; body: string[] }[];
  ifCounter: { n: number };
}

function sel(loc: Locator): string {
  return arg(buildSelector(loc));
}

function assertionCells(selector: string, a: Assertion): string[] {
  const expected = arg(a.expected);
  switch (a.property) {
    case 'text':
      return ['Get Text', selector, a.operator, expected];
    case 'value':
      return ['Get Property', selector, 'value', a.operator, expected];
    case 'attribute':
      return ['Get Attribute', selector, arg(a.name ?? ''), a.operator, expected];
    case 'count':
      return ['Get Element Count', selector, a.operator, expected];
    case 'state': {
      const negative = a.operator === '!=' || a.operator === 'not contains';
      return ['Get Element States', selector, negative ? 'not contains' : 'contains', expected];
    }
  }
}

function elementCells(step: ElementStep): string[] {
  const s = sel(step.locator);
  if (step.mode === 'assert') {
    return assertionCells(s, step.assertion ?? { property: 'state', operator: '==', expected: 'visible' });
  }
  const value = arg(step.action?.value ?? '');
  switch (step.action?.kind ?? 'click') {
    case 'click':
      return ['Click', s];
    case 'dblclick':
      return ['Click With Options', s, 'left', 'clickCount=2'];
    case 'rightclick':
      return ['Click', s, 'right'];
    case 'fill':
      return ['Fill Text', s, value];
    case 'hover':
      return ['Hover', s];
    case 'select':
      return ['Select Options By', s, 'label', value];
    case 'check':
      return ['Check Checkbox', s];
    case 'uncheck':
      return ['Uncheck Checkbox', s];
    case 'press':
      return ['Press Keys', s, arg(step.action?.value || 'Enter')];
  }
}

function stepLines(step: Step, ctx: Ctx, depth: number): string[] {
  const pad = IND.repeat(depth);
  const line = (...cells: string[]) => pad + row(...cells);
  switch (step.type) {
    case 'element':
      return [line(...elementCells(step))];
    case 'wait': {
      const w = step.wait;
      if (w.kind === 'time') return [line('Sleep', `${w.seconds}s`)];
      if (w.kind === 'load') return [line('Wait For Load State', w.state)];
      const cells = ['Wait For Elements State', sel(w.locator), w.state];
      if (w.timeoutSeconds) cells.push(`timeout=${w.timeoutSeconds}s`);
      return [line(...cells)];
    }
    case 'pause':
      return [line('Pause For Key', ...(step.message ? [arg(step.message)] : []))];
    case 'screenshot': {
      const cells = ['Take Screenshot', `filename=${arg('${SCREENSHOT_DIR}/' + step.filename)}`];
      if (step.fullPage) cells.push('fullPage=True');
      return [line(...cells)];
    }
    case 'keywordCall':
      return [line(ctx.keywordNames.get(step.keywordId) ?? `Fail    Missing keyword ${step.keywordId}`)];
    case 'raw':
      return step.lines.map((l) => pad + l.trim());
    case 'group': {
      const name = ctx.namer.take(step.name || 'Group');
      const body = stepsLines(step.steps, ctx, 1);
      ctx.local.push({ name, doc: `UITester group ${step.id}`, body });
      return [line(name)];
    }
    case 'if': {
      const v = `\${condition_${++ctx.ifCounter.n}}`;
      const cond = assertionCells(sel(step.condition.locator), step.condition.assertion);
      const out = [line(`${v}=`, 'Run Keyword And Return Status', ...cond), line('IF', v)];
      out.push(...(step.then.length ? stepsLines(step.then, ctx, depth + 1) : [pad + IND + 'No Operation']));
      if (step.else.length) out.push(line('ELSE'), ...stepsLines(step.else, ctx, depth + 1));
      out.push(line('END'));
      return out;
    }
  }
}

/** Robot cells normalized to single 4-space separators, for comparing generated and parsed lines. */
export function normalizeRow(line: string): string {
  return line.trim().split(/\s{2,}|\t/).join('    ');
}

/**
 * The line a leaf step generates (for an if: its condition call), used by the importer to
 * recognise unchanged steps and keep their ids and recorded element details.
 */
export function stepSignature(step: Step, keywordNames: Map<string, string> = new Map()): string | undefined {
  if (step.type === 'group') return undefined;
  if (step.type === 'if') {
    const cond = assertionCells(sel(step.condition.locator), step.condition.assertion);
    return normalizeRow(row('Run Keyword And Return Status', ...cond));
  }
  const ctx: Ctx = { keywords: [], keywordNames, namer: new KeywordNamer(), local: [], ifCounter: { n: 0 } };
  return stepLines(step, ctx, 0).map(normalizeRow).join('\n');
}

function stepsLines(steps: Step[], ctx: Ctx, depth: number): string[] {
  if (!steps.length) return [IND.repeat(depth) + 'No Operation'];
  return steps.flatMap((s) => stepLines(s, ctx, depth));
}

function keywordsSection(local: Ctx['local']): string[] {
  if (!local.length) return [];
  const out = ['', '*** Keywords ***'];
  for (const k of local) {
    out.push(k.name, IND + row('[Documentation]', arg(k.doc)), ...k.body, '');
  }
  out.pop();
  return out;
}

/** Stable keyword names for the linked (reusable) groups. */
export function sharedKeywordNames(keywords: Keyword[]): Map<string, string> {
  const namer = new KeywordNamer();
  return new Map(keywords.map((k) => [k.id, namer.take(k.name)]));
}

export function testFileName(project: Project, test: Test): string {
  const taken = new Map<string, number>();
  for (const t of project.tests) {
    const base = fileName(t.name);
    const n = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), n);
    if (t.id === test.id) return `tests/${n > 1 ? `${base}_${n}` : base}.robot`;
  }
  return `tests/${fileName(test.name)}.robot`;
}

function testFile(project: Project, test: Test, keywordNames: Map<string, string>): string {
  const ctx: Ctx = {
    keywords: project.keywords,
    keywordNames,
    namer: new KeywordNamer([...keywordNames.values(), test.name]),
    local: [],
    ifCounter: { n: 0 },
  };
  const body = stepsLines(test.steps, ctx, 1);
  const lines = [
    '*** Settings ***',
    row('Documentation', 'Generated by UITester. Edit this test in UITester; manual changes are detected when the project is opened.'),
    row('Resource', '../resources/uitester.resource'),
    row('Resource', '../resources/keywords.resource'),
    row('Variables', '../env/${ENV}.py'),
    row('Suite Setup', 'Open UITester Browser'),
    row('Suite Teardown', 'Close Browser', 'ALL'),
    '',
    '*** Variables ***',
    row('${ENV}', project.settings.environment),
    ...test.parameters.filter((p) => PARAM_NAME.test(p.name)).map((p) => row(`\${${p.name}}`, arg(parameterValue(p, project.settings.environment)))),
    '',
    '*** Test Cases ***',
    robotName(test.name),
    IND + row('[Documentation]', arg(`UITester test ${test.id}`)),
    IND + row('[Tags]', test.flow, test.kind),
    ...body,
    ...keywordsSection(ctx.local),
  ];
  return lines.join('\n') + '\n';
}

function keywordsResource(project: Project, keywordNames: Map<string, string>): string {
  const ctx: Ctx = {
    keywords: project.keywords,
    keywordNames,
    namer: new KeywordNamer([...keywordNames.values()]),
    local: [],
    ifCounter: { n: 0 },
  };
  const shared = project.keywords.map((k) => ({
    name: keywordNames.get(k.id)!,
    doc: `UITester keyword ${k.id}`,
    body: stepsLines(k.steps, ctx, 1),
  }));
  const lines = [
    '*** Settings ***',
    row('Documentation', 'Reusable groups (linked keywords) generated by UITester.'),
    row('Resource', 'uitester.resource'),
    ...keywordsSection([...shared, ...ctx.local]),
  ];
  return lines.join('\n') + '\n';
}

function screenshotDir(settings: Settings): string {
  const dir = settings.screenshotDir.replace(/\\/g, '/');
  return /^([A-Za-z]:)?\//.test(dir) ? dir : `\${CURDIR}/../${dir}`;
}

function uitesterResource(settings: Settings): string {
  const chromiumBased = settings.browser !== 'firefox';
  return [
    '*** Settings ***',
    row('Documentation', 'Browser setup and helpers generated by UITester. Override any variable with -v NAME:value.'),
    row('Library', 'Browser'),
    row('Library', 'UITesterLib.py'),
    '',
    '*** Variables ***',
    row('${BROWSER}', chromiumBased ? 'chromium' : 'firefox'),
    row('${CHANNEL}', settings.browser === 'msedge' ? 'msedge' : '${EMPTY}'),
    row('${HEADLESS}', settings.headless ? 'True' : 'False'),
    row('${WIDTH}', String(settings.width)),
    row('${HEIGHT}', String(settings.height)),
    row('${TIMEOUT}', `${settings.timeoutSeconds}s`),
    row('${SCREENSHOT_DIR}', screenshotDir(settings)),
    '',
    '*** Keywords ***',
    'Open UITester Browser',
    IND + row('IF', "'${CHANNEL}' != ''"),
    IND + IND + row('New Browser', '${BROWSER}', 'headless=${HEADLESS}', 'channel=${CHANNEL}'),
    IND + 'ELSE',
    IND + IND + row('New Browser', '${BROWSER}', 'headless=${HEADLESS}'),
    IND + 'END',
    IND + row('New Context', "viewport={'width': ${WIDTH}, 'height': ${HEIGHT}}"),
    IND + row('Set Browser Timeout', '${TIMEOUT}'),
    IND + row('New Page', '${URL}'),
    '',
  ].join('\n');
}

const UITESTER_LIB = `"""Helper keywords for tests generated by UITester."""
import os
import sys

from robot.api import logger
from robot.api.deco import keyword

__all__ = ["pause_for_key"]


@keyword("Pause For Key")
def pause_for_key(message="Paused by UITester. Press any key to continue..."):
    stdin = sys.__stdin__
    if os.environ.get("UITESTER_PAUSE") == "stdin" and stdin is not None:
        # Started from the UITester app: it shows a Continue button and writes a newline.
        # leading newline: Robot's console may be mid-line (test name printed, status pending)
        sys.__stdout__.write("\\n[UITESTER-PAUSE] " + message + "\\n")
        sys.__stdout__.flush()
        stdin.readline()
        return
    if stdin is None or not stdin.isatty():
        logger.warn("Pause skipped: no interactive terminal.")
        return
    sys.__stdout__.write("\\n" + message + "\\n")
    sys.__stdout__.flush()
    try:
        import msvcrt  # Windows: any key

        msvcrt.getch()
    except ImportError:
        stdin.readline()
`;

function pyString(value: string): string {
  return JSON.stringify(value);
}

function envFile(project: Project, env: (typeof ENVIRONMENTS)[number]): string {
  const lines = [`# UITester parameters for environment ${env}. Generated; edit parameters in UITester.`];
  for (const p of project.parameters) if (PARAM_NAME.test(p.name)) lines.push(`${p.name} = ${pyString(parameterValue(p, env))}`);
  return lines.join('\n') + '\n';
}

/** Stages from the run plan, with tests that are not in the plan appended one by one (series). */
export function effectiveRunPlan(project: Project): string[][] {
  const ids = new Set(project.tests.map((t) => t.id));
  const seen = new Set<string>();
  const stages: string[][] = [];
  for (const stage of project.settings.runPlan) {
    const tests = stage.tests.filter((id) => ids.has(id) && !seen.has(id));
    tests.forEach((id) => seen.add(id));
    if (tests.length) stages.push(tests);
  }
  for (const t of project.tests) if (!seen.has(t.id)) stages.push([t.id]);
  return stages;
}

export function suiteName(project: Project, test: Test): string {
  const base = testFileName(project, test).replace(/^tests\//, '').replace(/\.robot$/, '');
  return `Tests.${suiteNameFromFile(base)}`;
}

/** pabot --ordering file: #WAIT separates stages that must run in series. */
function orderingFile(project: Project): string {
  const byId = new Map(project.tests.map((t) => [t.id, t]));
  return effectiveRunPlan(project)
    .map((stage) => stage.map((id) => `--suite ${suiteName(project, byId.get(id)!)}`).join('\n'))
    .join('\n#WAIT\n') + '\n';
}

function runBat(settings: Settings): string {
  const retries = Array.from({ length: settings.retries }, (_, i) => [
    `if errorlevel 1 python -m robot -v ENV:%ENV% %EXTRA% --rerunfailed "%OUT%\\output.xml" --outputdir "%OUT%" --output rerun${i + 1}.xml --log NONE --report NONE tests`,
    `if exist "%OUT%\\rerun${i + 1}.xml" python -m robot.rebot --merge --outputdir "%OUT%" --output output.xml "%OUT%\\output.xml" "%OUT%\\rerun${i + 1}.xml"`,
  ]).flat();
  return [
    '@echo off',
    'REM Generated by UITester. Usage: run.bat [ENV] [extra robot args]  e.g. run.bat PROD -v HEADLESS:True',
    'setlocal',
    'cd /d "%~dp0"',
    'set ENV=%1',
    `if "%ENV%"=="" set ENV=${settings.environment}`,
    'set EXTRA=%2 %3 %4 %5 %6 %7 %8 %9',
    'for /f %%i in (\'powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"\') do set TS=%%i',
    'set OUT=logs\\%TS%',
    'python -m robot -v ENV:%ENV% %EXTRA% --outputdir "%OUT%" tests',
    ...retries,
    '',
  ].join('\r\n');
}

function runSh(settings: Settings): string {
  const retries = Array.from({ length: settings.retries }, (_, i) => [
    `if [ $status -ne 0 ]; then`,
    `  python -m robot -v "ENV:$ENV" "$@" --rerunfailed "$OUT/output.xml" --outputdir "$OUT" --output rerun${i + 1}.xml --log NONE --report NONE tests; status=$?`,
    `  python -m robot.rebot --merge --outputdir "$OUT" --output output.xml "$OUT/output.xml" "$OUT/rerun${i + 1}.xml"`,
    `fi`,
  ]).flat();
  return [
    '#!/bin/sh',
    '# Generated by UITester. Usage: ./run.sh [ENV] [extra robot args]  e.g. ./run.sh PROD -v HEADLESS:True',
    'cd "$(dirname "$0")"',
    `ENV="\${1:-${settings.environment}}"`,
    '[ $# -gt 0 ] && shift',
    'OUT="logs/$(date +%Y%m%d-%H%M%S)"',
    'python -m robot -v "ENV:$ENV" "$@" --outputdir "$OUT" tests; status=$?',
    ...retries,
    'exit $status',
    '',
  ].join('\n');
}

function runParallelBat(settings: Settings): string {
  return [
    '@echo off',
    'REM Generated by UITester. Runs the run plan with pabot (pip install robotframework-pabot).',
    'setlocal',
    'cd /d "%~dp0"',
    'set ENV=%1',
    `if "%ENV%"=="" set ENV=${settings.environment}`,
    'for /f %%i in (\'powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"\') do set TS=%%i',
    'python -m pabot.pabot --command python -m robot --end-command --ordering run_plan.txt -v ENV:%ENV% -v HEADLESS:True --outputdir "logs\\%TS%" tests',
    '',
  ].join('\r\n');
}

/** Every file UITester writes into the project folder, keyed by relative path (forward slashes). */
export function generateRobotFiles(project: Project): Record<string, string> {
  const keywordNames = sharedKeywordNames(project.keywords);
  const files: Record<string, string> = {};
  for (const test of project.tests) files[testFileName(project, test)] = testFile(project, test, keywordNames);
  files['resources/keywords.resource'] = keywordsResource(project, keywordNames);
  files['resources/uitester.resource'] = uitesterResource(project.settings);
  files['resources/UITesterLib.py'] = UITESTER_LIB;
  for (const env of ENVIRONMENTS) files[`env/${env}.py`] = envFile(project, env);
  files['run_plan.txt'] = orderingFile(project);
  files['run.bat'] = runBat(project.settings);
  files['run.sh'] = runSh(project.settings);
  files['run_parallel.bat'] = runParallelBat(project.settings);
  return files;
}
