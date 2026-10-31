import { ENVIRONMENTS } from '../model';
import type { Assertion, CustomCallStep, ElementStep, Environment, Keyword, Locator, Parameter, Project, Settings, Step, Test } from '../model';
import { PARAM_NAME } from '../factory';
import { DEFAULT_DATE_FORMAT } from '../date';
import { isComputed, parameterRefs, parameterValue, referenceOrder } from '../params';
import { buildSelector } from '../selector';
import { walk } from '../steps';
import { arg, fileName, robotName, row, suiteNameFromFile } from './escape';

const IND = '    ';
/** Local keyword of a test file that sets its random and date parameters before opening the browser. */
export const SUITE_SETUP = 'Joule Suite Setup';
export const SUITE_SETUP_DOC = 'Joule parameters';

/** Keywords the generated code calls; user group names must not shadow them. */
const RESERVED = new Set(
  [
    'Click', 'Click With Options', 'Fill Text', 'Hover', 'Select Options By', 'Check Checkbox', 'Uncheck Checkbox',
    'Press Keys', 'Get Text', 'Get Property', 'Get Attribute', 'Get Element Count', 'Get Element States', 'Sleep',
    'Wait For Load State', 'Wait For Elements State', 'Take Screenshot', 'Go To', 'Pause For Key', 'New Page', 'New Browser',
    'New Context', 'Close Browser', 'Open Joule Browser', 'Run Keyword And Return Status', 'Set Browser Timeout', 'Log',
    'Random From Regex', 'Relative Date', 'Set Suite Variable', SUITE_SETUP,
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
    case 'navigate':
      return [line('Go To', arg(step.url))];
    case 'keywordCall':
      return [line(ctx.keywordNames.get(step.keywordId) ?? `Fail    Missing keyword ${step.keywordId}`)];
    case 'customCall':
      return [line(robotName(step.keyword), ...Object.entries(step.args).map(([k, v]) => `${k}=${arg(v)}`))];
    case 'raw':
      return step.lines.map((l) => pad + l.trim());
    case 'group': {
      const name = ctx.namer.take(step.name || 'Group');
      const body = stepsLines(step.steps, ctx, 1);
      ctx.local.push({ name, doc: `Joule group ${step.id}`, body });
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

/** Custom keyword calls anywhere in these steps. */
function customCalls(steps: Step[]): CustomCallStep[] {
  return [...walk(steps)].flatMap((w) => (w.step.type === 'customCall' ? [w.step] : []));
}

/** Resource imports for the custom keyword files used (generated files sit one folder below the project). */
function customResources(calls: CustomCallStep[]): string[] {
  return [...new Set(calls.map((c) => c.source))].sort().map((src) => row('Resource', `../${src}`));
}

/** Names of the custom keywords a project calls; Joule's own keywords must not shadow them. */
export function usedCustomNames(project: Pick<Project, 'tests' | 'keywords'>): string[] {
  return customCalls([...project.tests.flatMap((t) => t.steps), ...project.keywords.flatMap((k) => k.steps)]).map((c) => c.keyword);
}

/** Stable keyword names for the linked (reusable) groups. */
export function sharedKeywordNames(keywords: Keyword[], reserved: string[] = []): Map<string, string> {
  const namer = new KeywordNamer(reserved);
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

const dateFormat = (p: Parameter) => p.format || DEFAULT_DATE_FORMAT;

/** A regex (or date expression) as one Robot argument: backslashes doubled and ${...} kept literal. */
function patternArg(pattern: string): string {
  return arg(pattern).replace(/[$@&%](?=\{)/g, '\\$&');
}

/**
 * Test parameters that must be set when the suite starts: random and date ones, and the ones
 * that reference them. The others stay in *** Variables ***, where Robot resolves ${refs} itself.
 */
function dynamicParameters(params: Parameter[], env: Environment): Parameter[] {
  const { order, cyclic } = referenceOrder(params, env);
  const dynamic = new Set<string>();
  for (const p of order) {
    if (isComputed(p) || (!cyclic.has(p.name) && parameterRefs(parameterValue(p, env)).some((r) => dynamic.has(r)))) dynamic.add(p.name);
  }
  return order.filter((p) => dynamic.has(p.name));
}

function suiteSetupBody(params: Parameter[], env: Environment): string[] {
  const lines = params.flatMap((p) => {
    const v = `\${${p.name}}`;
    const value = parameterValue(p, env);
    if (p.kind === 'random') return [IND + row(`${v}=`, 'Random From Regex', patternArg(value)), IND + row('Set Suite Variable', v)];
    if (p.kind === 'date') return [IND + row(`${v}=`, 'Relative Date', patternArg(value), patternArg(dateFormat(p))), IND + row('Set Suite Variable', v)];
    return [IND + row('Set Suite Variable', v, arg(value))];
  });
  return [...lines, IND + 'Open Joule Browser'];
}

function testFile(project: Project, test: Test, keywordNames: Map<string, string>): string {
  const env = project.settings.environment;
  const params = test.parameters.filter((p) => PARAM_NAME.test(p.name));
  const dynamic = dynamicParameters(params, env);
  const setup = dynamic.length ? [{ name: SUITE_SETUP, doc: SUITE_SETUP_DOC, body: suiteSetupBody(dynamic, env) }] : [];
  const custom = customCalls(test.steps);
  const ctx: Ctx = {
    keywords: project.keywords,
    keywordNames,
    namer: new KeywordNamer([...keywordNames.values(), test.name, ...custom.map((c) => c.keyword)]),
    local: [],
    ifCounter: { n: 0 },
  };
  const body = stepsLines(test.steps, ctx, 1);
  const lines = [
    '*** Settings ***',
    row('Documentation', 'Generated by Joule. Edit this test in Joule; manual changes are detected when the project is opened.'),
    row('Resource', '../resources/joule.resource'),
    row('Resource', '../resources/keywords.resource'),
    ...customResources(custom),
    row('Variables', '../env/${ENV}.py'),
    row('Suite Setup', setup.length ? SUITE_SETUP : 'Open Joule Browser'),
    row('Suite Teardown', 'Close Browser', 'ALL'),
    '',
    '*** Variables ***',
    row('${ENV}', env),
    ...params.filter((p) => !dynamic.includes(p)).map((p) => row(`\${${p.name}}`, arg(parameterValue(p, env)))),
    '',
    '*** Test Cases ***',
    robotName(test.name),
    IND + row('[Documentation]', arg(`Joule test ${test.id}`)),
    IND + row('[Tags]', test.flow, test.kind),
    ...body,
    ...keywordsSection([...setup, ...ctx.local]),
  ];
  return lines.join('\n') + '\n';
}

function keywordsResource(project: Project, keywordNames: Map<string, string>): string {
  const custom = customCalls(project.keywords.flatMap((k) => k.steps));
  const ctx: Ctx = {
    keywords: project.keywords,
    keywordNames,
    namer: new KeywordNamer([...keywordNames.values(), ...custom.map((c) => c.keyword)]),
    local: [],
    ifCounter: { n: 0 },
  };
  const shared = project.keywords.map((k) => ({
    name: keywordNames.get(k.id)!,
    doc: `Joule keyword ${k.id}`,
    body: stepsLines(k.steps, ctx, 1),
  }));
  const lines = [
    '*** Settings ***',
    row('Documentation', 'Reusable groups (linked keywords) generated by Joule.'),
    row('Resource', 'joule.resource'),
    ...customResources(custom),
    ...keywordsSection([...shared, ...ctx.local]),
  ];
  return lines.join('\n') + '\n';
}

function screenshotDir(settings: Settings): string {
  const dir = settings.screenshotDir.replace(/\\/g, '/');
  return /^([A-Za-z]:)?\//.test(dir) ? dir : `\${CURDIR}/../${dir}`;
}

function jouleResource(settings: Settings): string {
  const chromiumBased = settings.browser !== 'firefox';
  return [
    '*** Settings ***',
    row('Documentation', 'Browser setup and helpers generated by Joule. Override any variable with -v NAME:value.'),
    row('Library', 'Browser'),
    row('Library', 'JouleLib.py'),
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
    'Open Joule Browser',
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

const JOULE_LIB = `"""Helper keywords for tests generated by Joule."""
import calendar
import datetime
import os
import random
import re
import sys

from robot.api import logger
from robot.api.deco import keyword

try:
    from re import _constants as _sre, _parser as _sre_parse  # Python 3.11+
except ImportError:
    import sre_constants as _sre
    import sre_parse as _sre_parse

__all__ = ["pause_for_key", "random_from_regex", "relative_date"]

# Same character sets and repeat cap as Joule's own generator (random.ts).
_PRINTABLE = [chr(c) for c in range(0x20, 0x7F)]
_DIGIT = [c for c in _PRINTABLE if c.isdigit()]
_WORD = [c for c in _PRINTABLE if c.isalnum() or c == "_"]
_SPACE = [" "]
_CATEGORIES = {
    _sre.CATEGORY_DIGIT: _DIGIT,
    _sre.CATEGORY_NOT_DIGIT: [c for c in _PRINTABLE if c not in _DIGIT],
    _sre.CATEGORY_WORD: _WORD,
    _sre.CATEGORY_NOT_WORD: [c for c in _PRINTABLE if c not in _WORD],
    _sre.CATEGORY_SPACE: _SPACE,
    _sre.CATEGORY_NOT_SPACE: [c for c in _PRINTABLE if c not in _SPACE],
}
_REPEAT_CAP = 8
_REPEATS = tuple(op for op in (_sre.MAX_REPEAT, _sre.MIN_REPEAT, getattr(_sre, "POSSESSIVE_REPEAT", None)) if op is not None)


def _charset(items):
    chars = set()
    negate = False
    for op, av in items:
        if op == _sre.NEGATE:
            negate = True
        elif op == _sre.LITERAL:
            chars.add(chr(av))
        elif op == _sre.RANGE:
            chars.update(chr(c) for c in range(av[0], av[1] + 1))
        elif op == _sre.CATEGORY:
            chars.update(_CATEGORIES[av])
        else:
            raise ValueError("Unsupported character class item: %s" % op)
    return [c for c in _PRINTABLE if c not in chars] if negate else sorted(chars)


def _generate(pattern, groups):
    out = []
    for op, av in pattern:
        if op == _sre.LITERAL:
            out.append(chr(av))
        elif op == _sre.NOT_LITERAL:
            out.append(random.choice([c for c in _PRINTABLE if c != chr(av)]))
        elif op == _sre.ANY:
            out.append(random.choice(_PRINTABLE))
        elif op == _sre.IN:
            out.append(random.choice(_charset(av)))
        elif op == _sre.BRANCH:
            out.append(_generate(random.choice(av[1]), groups))
        elif op == _sre.SUBPATTERN:
            value = _generate(av[-1], groups)
            if av[0] is not None:
                groups[av[0]] = value
            out.append(value)
        elif op in _REPEATS:
            low, high, sub = av
            if high == _sre.MAXREPEAT:
                high = low + _REPEAT_CAP
            out.extend(_generate(sub, groups) for _ in range(random.randint(low, high)))
        elif op == _sre.AT:
            pass
        elif op == _sre.GROUPREF:
            out.append(groups.get(av, ""))
        else:
            raise ValueError("Unsupported regex syntax: %s" % op)
    return "".join(out)


@keyword("Random From Regex")
def random_from_regex(pattern):
    """A random string that matches the regular expression; a new one on every call."""
    return _generate(_sre_parse.parse(pattern), {})


# Same grammar, units and format tokens as Joule's own date expressions (date.ts).
_DATE_UNITS = {
    "d": "d", "day": "d", "days": "d",
    "wd": "wd", "workday": "wd", "workdays": "wd",
    "w": "w", "week": "w", "weeks": "w",
    "m": "m", "month": "m", "months": "m",
    "y": "y", "year": "y", "years": "y",
    "h": "h", "hour": "h", "hours": "h",
    "min": "min", "minute": "min", "minutes": "min",
}
_RELATIVE = re.compile(r"^(today|now)(.*)$")
_OFFSET = re.compile(r"\\s*([+-])\\s*([0-9]+)\\s*([a-z]+)")
_ISO = re.compile(r"^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})(?:\\s+([0-9]{1,2}):([0-9]{2}))?$")
_DMY = re.compile(r"^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{4})(?:\\s+([0-9]{1,2}):([0-9]{2}))?$")
_DATE_TOKENS = re.compile(r"yyyy|yy|MM|M|dd|d|HH|H|mm|ss")
DEFAULT_DATE_FORMAT = "${DEFAULT_DATE_FORMAT}"


def _now():
    return datetime.datetime.now().replace(microsecond=0)


def _add_months(d, n):
    year, month = divmod(d.year * 12 + d.month - 1 + n, 12)
    day = min(d.day, calendar.monthrange(year, month + 1)[1])
    return d.replace(year=year, month=month + 1, day=day)


def _add_workdays(d, n):
    step = -1 if n < 0 else 1
    left = abs(n)
    while left > 0:
        d += datetime.timedelta(days=step)
        if d.weekday() < 5:
            left -= 1
    return d


def _shift(d, n, unit):
    if unit == "d":
        return d + datetime.timedelta(days=n)
    if unit == "w":
        return d + datetime.timedelta(weeks=n)
    if unit == "wd":
        return _add_workdays(d, n)
    if unit == "m":
        return _add_months(d, n)
    if unit == "y":
        return _add_months(d, 12 * n)
    if unit == "h":
        return d + datetime.timedelta(hours=n)
    return d + datetime.timedelta(minutes=n)


def _absolute(s):
    iso = _ISO.match(s)
    m = iso or _DMY.match(s)
    if not m:
        raise ValueError("Expected today, now or a date such as 2026-12-25")
    year, month, day = (int(m.group(i)) for i in ((1, 2, 3) if iso else (3, 2, 1)))
    hours, minutes = int(m.group(4) or 0), int(m.group(5) or 0)
    if not 1 <= month <= 12:
        raise ValueError("Month %d does not exist" % month)
    if not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise ValueError("Day %d does not exist in %d-%02d" % (day, year, month))
    if hours > 23 or minutes > 59:
        raise ValueError("Time %s:%s does not exist" % (m.group(4), m.group(5)))
    return datetime.datetime(year, month, day, hours, minutes)


def _evaluate(expression):
    s = expression.strip().lower()
    if not s:
        raise ValueError("Empty date")
    rel = _RELATIVE.match(s)
    if not rel:
        return _absolute(s)
    d = _now()
    if rel.group(1) == "today":
        d = d.replace(hour=0, minute=0, second=0)
    rest = rel.group(2)
    while rest.strip():
        m = _OFFSET.match(rest)
        if not m:
            raise ValueError('Expected an offset such as "+ 3d" at "%s"' % rest.strip())
        unit = _DATE_UNITS.get(m.group(3))
        if unit is None:
            raise ValueError('Unknown unit "%s"' % m.group(3))
        d = _shift(d, (-1 if m.group(1) == "-" else 1) * int(m.group(2)), unit)
        rest = rest[m.end():]
    return d


def _format_date(d, fmt):
    values = {
        "yyyy": "%04d" % d.year,
        "yy": "%02d" % (d.year % 100),
        "MM": "%02d" % d.month,
        "M": str(d.month),
        "dd": "%02d" % d.day,
        "d": str(d.day),
        "HH": "%02d" % d.hour,
        "H": str(d.hour),
        "mm": "%02d" % d.minute,
        "ss": "%02d" % d.second,
    }
    return _DATE_TOKENS.sub(lambda m: values[m.group(0)], fmt or DEFAULT_DATE_FORMAT)


@keyword("Relative Date")
def relative_date(expression, fmt=DEFAULT_DATE_FORMAT):
    """The date of an expression such as "today + 5wd", "now - 2h" or "2026-12-25", written out in fmt (e.g. dd-MM-yyyy)."""
    return _format_date(_evaluate(expression), fmt)


@keyword("Pause For Key")
def pause_for_key(message="Paused by Joule. Press any key to continue..."):
    stdin = sys.__stdin__
    if os.environ.get("JOULE_PAUSE") == "stdin" and stdin is not None:
        # Started from the Joule app: it shows a Continue button and writes a newline.
        # leading newline: Robot's console may be mid-line (test name printed, status pending)
        sys.__stdout__.write("\\n[JOULE-PAUSE] " + message + "\\n")
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

/** Python expression for a text value: ${refs} to the names in `known` become variables, the rest stays literal. */
function pyConcat(value: string, known: (name: string) => boolean): string {
  const parts: string[] = [];
  let text = '';
  let last = 0;
  for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
    text += value.slice(last, m.index);
    last = m.index! + m[0].length;
    if (!known(m[1])) {
      text += m[0];
      continue;
    }
    if (text) parts.push(pyString(text));
    parts.push(m[1]);
    text = '';
  }
  text += value.slice(last);
  if (text || !parts.length) parts.push(pyString(text));
  return parts.join(' + ');
}

/** Lines that import the JouleLib helpers the computed parameters of an env file use. */
function envImports(params: Parameter[]): string[] {
  const helpers = [
    params.some((p) => p.kind === 'random') && 'random_from_regex as _random_from_regex',
    params.some((p) => p.kind === 'date') && 'relative_date as _relative_date',
  ].filter(Boolean);
  if (!helpers.length) return [];
  return [
    'import os as _os',
    'import sys as _sys',
    '',
    '_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "resources"))',
    `from JouleLib import ${helpers.join(', ')}  # noqa: E402`,
    '',
  ];
}

function envFile(project: Project, env: Environment): string {
  const params = project.parameters.filter((p) => PARAM_NAME.test(p.name));
  const { order, cyclic } = referenceOrder(params, env);
  const names = new Set(params.map((p) => p.name));
  const lines = [`# Joule parameters for environment ${env}. Generated; edit parameters in Joule.`];
  lines.push(...envImports(params));
  for (const p of order) {
    const value = parameterValue(p, env);
    if (p.kind === 'random') lines.push(`${p.name} = _random_from_regex(${pyString(value)})`);
    else if (p.kind === 'date') lines.push(`${p.name} = _relative_date(${pyString(value)}, ${pyString(dateFormat(p))})`);
    else lines.push(`${p.name} = ${pyConcat(value, (n) => names.has(n) && !cyclic.has(n))}`);
  }
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
    'REM Generated by Joule. Usage: run.bat [ENV] [extra robot args]  e.g. run.bat PROD -v HEADLESS:True',
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
    '# Generated by Joule. Usage: ./run.sh [ENV] [extra robot args]  e.g. ./run.sh PROD -v HEADLESS:True',
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
    'REM Generated by Joule. Runs the run plan with pabot (pip install robotframework-pabot).',
    'setlocal',
    'cd /d "%~dp0"',
    'set ENV=%1',
    `if "%ENV%"=="" set ENV=${settings.environment}`,
    'for /f %%i in (\'powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"\') do set TS=%%i',
    'python -m pabot.pabot --command python -m robot --end-command --ordering run_plan.txt -v ENV:%ENV% -v HEADLESS:True --outputdir "logs\\%TS%" tests',
    '',
  ].join('\r\n');
}

/** Every file Joule writes into the project folder, keyed by relative path (forward slashes). */
export function generateRobotFiles(project: Project): Record<string, string> {
  const keywordNames = sharedKeywordNames(project.keywords, usedCustomNames(project));
  const files: Record<string, string> = {};
  for (const test of project.tests) files[testFileName(project, test)] = testFile(project, test, keywordNames);
  files['resources/keywords.resource'] = keywordsResource(project, keywordNames);
  files['resources/joule.resource'] = jouleResource(project.settings);
  files['resources/JouleLib.py'] = JOULE_LIB;
  for (const env of ENVIRONMENTS) files[`env/${env}.py`] = envFile(project, env);
  files['run_plan.txt'] = orderingFile(project);
  files['run.bat'] = runBat(project.settings);
  files['run.sh'] = runSh(project.settings);
  files['run_parallel.bat'] = runParallelBat(project.settings);
  return files;
}
