/**
 * Turn parsed Robot Framework files (see engine/parse_robot.py) back into a Joule project.
 * Known Browser library keywords become steps; anything else is kept verbatim as a raw step.
 */
import { customKeywordsFrom, type CustomKeyword, type ParsedCustomFile } from '../custom';
import { newId } from '../ids';
import { ENVIRONMENTS, Project as ProjectSchema } from '../model';
import type { Action, Assertion, AssertProperty, Keyword, Locator, Operator, Parameter, Project, Step, Test } from '../model';
import { OPERATORS } from '../model';
import { DEFAULT_DATE_FORMAT } from '../date';
import { parameterValue } from '../params';
import { walk } from '../steps';
import { unarg, row } from './escape';
import { normalizeRow, sharedKeywordNames, stepSignature, SUITE_SETUP, usedCustomNames } from './generate';

export interface ParsedCall {
  kind: 'call';
  keyword: string;
  args: string[];
  assign: string[];
  lines: string[];
}
export interface ParsedIf {
  kind: 'if';
  branches: { condition: string | null; body: ParsedItem[] }[];
  lines: string[];
}
export type ParsedItem =
  | ParsedCall
  | ParsedIf
  | { kind: 'raw'; lines: string[] }
  | { kind: 'doc'; value: string }
  | { kind: 'tags'; values: string[] };

export interface ParsedFile {
  file: string;
  error?: string;
  tests: { name: string; body: ParsedItem[] }[];
  keywords: { name: string; body: ParsedItem[] }[];
  variables: { name: string; value: string[] }[];
  settings: string[][];
}

export interface ParsedFolder {
  files: ParsedFile[];
  /** Keyword files in custom_keywords/ (not part of `files`). */
  custom?: ParsedCustomFile[];
  env: Record<string, Record<string, string>>;
  /** Random parameters (name → regex) per env file. */
  envRandom?: Record<string, Record<string, string>>;
  /** Date parameters (name → expression and format) per env file. */
  envDate?: Record<string, Record<string, { expression: string; format?: string }>>;
}

const norm = (name: string) => name.toLowerCase().replace(/^browser\./, '').replace(/[\s_]/g, '');
// The uitester names are what projects generated before the rename to Joule contain.
const HELPER_RESOURCES = new Set(['resources/joule.resource', 'resources/uitester.resource']);
const OPEN_BROWSER = new Set(['openjoulebrowser', 'openuitesterbrowser']);
const SETUP_KEYWORDS = new Set(['newbrowser', 'newcontext', 'newpage', 'closebrowser', ...OPEN_BROWSER, 'openbrowser', 'closeallbrowsers']);

function locator(selector: string): Locator {
  const s = unarg(selector);
  const tag = /^css=([a-z][a-z0-9-]*)/i.exec(s)?.[1]?.toLowerCase() ?? '*';
  return { props: { tag, classes: [], attributes: {} }, use: [], custom: s };
}

function named(args: string[], name: string): string | undefined {
  const a = args.find((x) => x.toLowerCase().startsWith(`${name.toLowerCase()}=`));
  return a ? unarg(a.slice(name.length + 1)) : undefined;
}

/** Named arguments of the Browser keywords we map; `text=Buy` is a selector, not a named argument. */
const NAMED_ARGS = new Set(['selector', 'button', 'clickcount', 'txt', 'timeout', 'filename', 'fullpage', 'delay', 'clear', 'force', 'nowaitafter', 'modifiers', 'attribute', 'values', 'keys']);
const positional = (args: string[]) => args.filter((a) => !NAMED_ARGS.has(/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(a)?.[1]?.toLowerCase() ?? ''));

function operator(op: string | undefined): Operator | undefined {
  const map: Record<string, Operator> = { equal: '==', equals: '==', '*=': 'contains', '^=': 'starts', '$=': 'ends', 'should be': '==', inequal: '!=' };
  const o = (op ?? '').toLowerCase();
  return (OPERATORS as readonly string[]).includes(o) ? (o as Operator) : map[o];
}

/** An assertion keyword call → locator + assertion (used for element asserts and if conditions). */
function assertionFrom(kw: string, args: string[]): { locator: Locator; assertion: Assertion } | undefined {
  const [sel, ...rest] = args;
  if (!sel) return undefined;
  const build = (property: AssertProperty, opIndex: number, name?: string) => {
    const op = operator(rest[opIndex]);
    if (!op) return undefined;
    return { locator: locator(sel), assertion: { property, name, operator: op, expected: unarg(rest[opIndex + 1] ?? '') } };
  };
  switch (kw) {
    case 'gettext':
      return build('text', 0);
    case 'getproperty':
      return rest[0] === 'value' ? build('value', 1) : undefined;
    case 'getattribute':
      return build('attribute', 1, unarg(rest[0] ?? ''));
    case 'getelementcount':
      return build('count', 0);
    case 'getelementstates': {
      const op = rest[0] === 'not contains' ? '!=' : rest[0] === 'contains' ? '==' : undefined;
      if (!op || !rest[1]) return undefined;
      return { locator: locator(sel), assertion: { property: 'state', operator: op, expected: unarg(rest[1]) } };
    }
  }
  return undefined;
}

function actionFrom(kw: string, args: string[]): { locator: Locator; action: Action } | undefined {
  const pos = positional(args);
  const sel = pos[0];
  if (!sel) return undefined;
  const loc = locator(sel);
  const value = (i: number) => unarg(pos[i] ?? '');
  switch (kw) {
    case 'click': {
      const button = named(args, 'button') ?? pos[1] ?? 'left';
      if (button === 'right') return { locator: loc, action: { kind: 'rightclick' } };
      return button === 'left' ? { locator: loc, action: { kind: 'click' } } : undefined;
    }
    case 'clickwithoptions':
      return named(args, 'clickCount') === '2' ? { locator: loc, action: { kind: 'dblclick' } } : undefined;
    case 'filltext':
    case 'typetext':
      return { locator: loc, action: { kind: 'fill', value: named(args, 'txt') ?? value(1) } };
    case 'hover':
      return { locator: loc, action: { kind: 'hover' } };
    case 'selectoptionsby':
      return pos.length === 3 ? { locator: loc, action: { kind: 'select', value: value(2) } } : undefined;
    case 'checkcheckbox':
      return { locator: loc, action: { kind: 'check' } };
    case 'uncheckcheckbox':
      return { locator: loc, action: { kind: 'uncheck' } };
    case 'presskeys':
      return pos.length === 2 ? { locator: loc, action: { kind: 'press', value: value(1) } } : undefined;
  }
  return undefined;
}

interface Scope {
  /** normalized name → keyword body, for keywords defined in the same file (become groups) */
  local: Map<string, { name: string; body: ParsedItem[]; doc?: string }>;
  /** normalized name → shared keyword id */
  shared: Map<string, string>;
  /** normalized name → keyword from custom_keywords/ */
  custom: Map<string, CustomKeyword>;
  /** signature → existing steps, to keep ids and element details of unchanged steps */
  pool: Map<string, Step[]>;
  warnings: string[];
  depth: number;
}

function fromPool(scope: Scope, signature: string | undefined, fresh: Step): Step {
  const list = signature ? scope.pool.get(signature) : undefined;
  const old = list?.shift();
  if (!old) return fresh;
  if (old.type === 'if' && fresh.type === 'if') return { ...old, then: fresh.then, else: fresh.else };
  return old;
}

function rawStep(lines: string[]): Step {
  return { id: newId('s'), name: '', type: 'raw', lines: lines.map((l) => l.trim()).filter(Boolean) };
}

function docOf(body: ParsedItem[]): string | undefined {
  const d = body.find((b) => b.kind === 'doc');
  return d && d.kind === 'doc' ? d.value : undefined;
}

/** A call of a custom keyword with arguments Joule can edit (by name, or positional in order), else undefined. */
function customCallFrom(c: ParsedCall, def: CustomKeyword): Step | undefined {
  const editable = new Set(def.args.filter((a) => a.kind === 'arg' || a.kind === 'named').map((a) => a.name));
  const positional = def.args.filter((a) => a.kind === 'arg');
  const hasKwargs = def.args.some((a) => a.kind === 'kwargs');
  const args: Record<string, string> = {};
  let named = false;
  for (const cell of c.args) {
    const m = /^([A-Za-z_][\w ]*)=(.*)$/s.exec(cell);
    if (m && editable.has(m[1])) {
      args[m[1]] = unarg(m[2]);
      named = true;
      continue;
    }
    // positional after named, more values than arguments, or a free name=value for &{kwargs}
    const a = positional[Object.keys(args).length];
    if (named || !a || (m && hasKwargs)) return undefined;
    args[a.name] = unarg(cell);
  }
  return { id: newId('s'), name: '', type: 'customCall', keyword: def.name, source: def.source, args };
}

function convertCall(c: ParsedCall, scope: Scope): Step | undefined {
  const kw = norm(c.keyword);
  const sig = normalizeRow(c.lines.join(' ').trim());
  if (SETUP_KEYWORDS.has(kw)) {
    if (!OPEN_BROWSER.has(kw) && kw !== 'closebrowser') scope.warnings.push(`Kept browser setup line as raw Robot: ${c.lines[0]?.trim()}`);
    return OPEN_BROWSER.has(kw) || kw === 'closebrowser' ? undefined : rawStep(c.lines);
  }
  if (!c.assign.length) {
    const action = actionFrom(kw, c.args);
    if (action) return fromPool(scope, sig, { id: newId('s'), name: '', type: 'element', mode: 'action', ...action });
    const assert = assertionFrom(kw, c.args);
    if (assert) return fromPool(scope, sig, { id: newId('s'), name: '', type: 'element', mode: 'assert', ...assert });
    if (kw === 'sleep' && c.args.length === 1) {
      const seconds = parseFloat(c.args[0]);
      if (!Number.isNaN(seconds) && /^\d+(\.\d+)?\s*(s|sec|seconds?)?$/i.test(c.args[0].trim())) {
        return fromPool(scope, sig, { id: newId('s'), name: '', type: 'wait', wait: { kind: 'time', seconds } });
      }
    }
    if (kw === 'waitforloadstate') {
      const state = (c.args[0] ?? 'load') as 'load' | 'domcontentloaded' | 'networkidle';
      if (['load', 'domcontentloaded', 'networkidle'].includes(state)) return fromPool(scope, sig, { id: newId('s'), name: '', type: 'wait', wait: { kind: 'load', state } });
    }
    if (kw === 'waitforelementsstate' && c.args[0]) {
      const state = (c.args[1] ?? 'visible') as 'visible';
      const timeout = named(c.args, 'timeout');
      if (['visible', 'hidden', 'attached', 'detached', 'enabled'].includes(state)) {
        return fromPool(scope, sig, {
          id: newId('s'),
          name: '',
          type: 'wait',
          wait: { kind: 'element', locator: locator(c.args[0]), state, timeoutSeconds: timeout ? parseFloat(timeout) : undefined },
        });
      }
    }
    if (kw === 'takescreenshot') {
      const filename = named(c.args, 'filename') ?? '';
      const m = /^\$\{SCREENSHOT_DIR\}\/(.+)$/.exec(filename);
      if (m) return fromPool(scope, sig, { id: newId('s'), name: '', type: 'screenshot', filename: m[1], fullPage: /^true$/i.test(named(c.args, 'fullPage') ?? '') });
    }
    if (kw === 'goto' && c.args.length === 1) {
      return fromPool(scope, sig, { id: newId('s'), name: '', type: 'navigate', url: unarg(named(c.args, 'url') ?? c.args[0]) });
    }
    if (kw === 'pauseforkey') return fromPool(scope, sig, { id: newId('s'), name: '', type: 'pause', message: c.args[0] ? unarg(c.args[0]) : undefined });
    if (!c.args.length && scope.shared.has(kw)) {
      return fromPool(scope, sig, { id: newId('s'), name: '', type: 'keywordCall', keywordId: scope.shared.get(kw)! });
    }
    const local = !c.args.length ? scope.local.get(kw) : undefined;
    if (local && scope.depth < 20) {
      const doc = docOf(local.body);
      const id = /^(?:Joule|UITester) group (\S+)/.exec(doc ?? '')?.[1] ?? newId('s');
      const steps = convertBody(local.body, { ...scope, depth: scope.depth + 1 });
      return { id, name: local.name, type: 'group', collapsed: false, steps };
    }
    const custom = scope.custom.get(kw);
    const call = custom && customCallFrom(c, custom);
    if (call) return fromPool(scope, sig, call);
  }
  return rawStep(c.lines);
}

function convertBody(body: ParsedItem[], scope: Scope): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (item.kind === 'doc' || item.kind === 'tags') continue;
    if (item.kind === 'raw') {
      if (item.lines.every((l) => /^\s*No Operation\s*$/i.test(l))) continue;
      out.push(rawStep(item.lines));
      continue;
    }
    if (item.kind === 'if') {
      out.push(rawStep(item.lines));
      continue;
    }
    // ${c}=  Run Keyword And Return Status  <assert>  followed by  IF  ${c}  [ELSE]  END
    const next = body[i + 1];
    if (item.assign.length === 1 && norm(item.keyword) === 'runkeywordandreturnstatus' && next?.kind === 'if') {
      const v = item.assign[0].replace(/=\s*$/, '').trim();
      const [kwName, ...kwArgs] = item.args;
      const cond = kwName ? assertionFrom(norm(kwName), kwArgs) : undefined;
      const branches = next.branches;
      const simple = branches[0].condition?.trim() === v && branches.length <= 2 && (branches.length === 1 || branches[1].condition === null);
      if (cond && simple) {
        const sig = normalizeRow(row('Run Keyword And Return Status', ...item.args));
        out.push(
          fromPool(scope, sig, {
            id: newId('s'),
            name: '',
            type: 'if',
            condition: cond,
            then: convertBody(branches[0].body, scope),
            else: branches[1] ? convertBody(branches[1].body, scope) : [],
          }),
        );
        i++;
        continue;
      }
    }
    const step = convertCall(item, scope);
    if (step) out.push(step);
  }
  return out;
}

function signaturePool(steps: Step[], keywordNames: Map<string, string>): Map<string, Step[]> {
  const pool = new Map<string, Step[]>();
  for (const { step } of walk(steps)) {
    const sig = stepSignature(step, keywordNames);
    if (!sig) continue;
    pool.set(sig, [...(pool.get(sig) ?? []), step]);
  }
  return pool;
}

function varName(name: string): string {
  return name.replace(/^[$@&]\{/, '').replace(/\}=?\s*$/, '');
}

/** A date format as stored on a parameter: missing when it is the default. */
const formatField = (format: string | undefined) => (format && format !== DEFAULT_DATE_FORMAT ? { format } : {});

/** Test parameters set by the generated suite setup keyword (random and date ones, and the ones using them). */
function setupParameters(body: ParsedItem[]): Parameter[] {
  const out: Parameter[] = [];
  for (const c of body) {
    if (c.kind !== 'call') continue;
    const kw = norm(c.keyword);
    if (kw === 'randomfromregex' && c.assign.length === 1) {
      out.push({ name: varName(c.assign[0]), kind: 'random', values: { default: unarg(c.args[0] ?? '') } });
    } else if (kw === 'relativedate' && c.assign.length === 1) {
      const format = c.args[1] === undefined ? undefined : unarg(c.args[1]);
      out.push({ name: varName(c.assign[0]), kind: 'date', ...formatField(format), values: { default: unarg(c.args[0] ?? '') } });
    } else if (kw === 'setsuitevariable' && c.args.length === 2) {
      out.push({ name: varName(c.args[0]), values: { default: unarg(c.args[1]) } });
    }
  }
  return out;
}

/** Parameters sorted as in `old`; new ones go last. */
function inOldOrder(params: Parameter[], old: Parameter[]): Parameter[] {
  const at = (p: Parameter) => {
    const i = old.findIndex((o) => o.name === p.name);
    return i < 0 ? old.length : i;
  };
  return [...params].sort((a, b) => at(a) - at(b));
}

/** Build a project from parsed files. `existing` (the joule.json) keeps settings and recorded element details. */
export function importParsed(parsed: ParsedFolder, name: string, existing?: Project): { project: Project; warnings: string[] } {
  const warnings: string[] = [];
  for (const f of parsed.files) if (f.error) warnings.push(`${f.file}: ${f.error}`);
  const files = parsed.files.filter((f) => !f.error && !HELPER_RESOURCES.has(f.file));
  const oldKeywordNames = existing ? sharedKeywordNames(existing.keywords, usedCustomNames(existing)) : new Map<string, string>();
  const custom = new Map(customKeywordsFrom(parsed.custom ?? []).keywords.map((k) => [norm(k.name), k]));

  // Shared keywords: everything defined in .resource files.
  const sharedDefs = files.filter((f) => f.file.endsWith('.resource')).flatMap((f) => f.keywords.map((k) => ({ file: f, k })));
  const shared = new Map<string, string>();
  const keywordIds = sharedDefs.map(({ k }) => {
    const id = /^(?:Joule|UITester) keyword (\S+)/.exec(docOf(k.body) ?? '')?.[1] ?? newId('k');
    shared.set(norm(k.name), id);
    return id;
  });
  // Groups inside keywords.resource are generated as extra keywords there; they are local to that file, not shared.
  const groupNames = new Set(
    sharedDefs.filter(({ k }) => /^(?:Joule|UITester) group /.test(docOf(k.body) ?? '')).map(({ k }) => norm(k.name)),
  );
  for (const g of groupNames) shared.delete(g);

  const keywords: Keyword[] = [];
  sharedDefs.forEach(({ file, k }, i) => {
    if (groupNames.has(norm(k.name))) return;
    const old = existing?.keywords.find((x) => x.id === keywordIds[i]);
    const scope: Scope = {
      local: new Map(file.keywords.filter((x) => groupNames.has(norm(x.name))).map((x) => [norm(x.name), x])),
      shared,
      custom,
      pool: signaturePool(old?.steps ?? [], oldKeywordNames),
      warnings,
      depth: 0,
    };
    keywords.push({ id: keywordIds[i], name: k.name, steps: convertBody(k.body, scope) });
  });

  // Tests: every test case in .robot files.
  const tests: Test[] = [];
  let firstUrl: string | undefined;
  for (const f of files.filter((x) => x.file.endsWith('.robot'))) {
    const local = new Map(f.keywords.map((k) => [norm(k.name), k]));
    const params: Parameter[] = f.variables
      .filter((v) => varName(v.name) !== 'ENV' && v.name.startsWith('$'))
      .map((v) => ({ name: varName(v.name), values: { default: unarg(v.value.join(' ')) } }));
    const setup = local.get(norm(SUITE_SETUP));
    if (setup) params.push(...setupParameters(setup.body));
    for (const t of f.tests) {
      const doc = docOf(t.body) ?? '';
      const id = /^(?:Joule|UITester) test (\S+)/.exec(doc)?.[1] ?? newId('t');
      const old = existing?.tests.find((x) => x.id === id);
      const tags = t.body.flatMap((b) => (b.kind === 'tags' ? b.values : [])).map((x) => x.toLowerCase());
      const scope: Scope = { local, shared, custom, pool: signaturePool(old?.steps ?? [], oldKeywordNames), warnings, depth: 0 };
      const steps = convertBody(t.body, scope);
      if (!firstUrl) {
        const open = t.body.find((b): b is ParsedCall => b.kind === 'call' && ['newpage', 'goto', 'openbrowser'].includes(norm(b.keyword)));
        if (open?.args[0] && !open.args[0].startsWith('${')) firstUrl = unarg(open.args[0]);
      }
      tests.push({
        id,
        name: t.name,
        flow: tags.includes('unhappy') ? 'unhappy' : 'happy',
        kind: tags.includes('smoke') ? 'smoke' : 'regression',
        parameters: old ? inOldOrder(params, old.parameters).map((p) => ({ ...p, values: { ...(old.parameters.find((o) => o.name === p.name)?.values ?? {}), default: p.values.default } })) : params,
        steps,
      });
    }
  }

  // Project parameters: env/*.py variable files (generated by Joule) or the existing ones.
  const parameters: Parameter[] = existing ? structuredClone(existing.parameters) : [];
  // Kind (and date format) per name as found in the env files; a random or date one wins over text.
  const kinds = new Map<string, Pick<Parameter, 'kind' | 'format'>>();
  for (const env of [...ENVIRONMENTS]) {
    const entries: { key: string; value: string; kind?: Parameter['kind']; format?: string }[] = [
      ...Object.entries(parsed.env[env] ?? {}).map(([key, value]) => ({ key, value })),
      ...Object.entries(parsed.envRandom?.[env] ?? {}).map(([key, value]) => ({ key, value, kind: 'random' as const })),
      ...Object.entries(parsed.envDate?.[env] ?? {}).map(([key, d]) => ({ key, value: d.expression, kind: 'date' as const, format: d.format })),
    ];
    for (const { key, value, kind, format } of entries) {
      if (key === 'SCREENSHOT_DIR') continue;
      if (!kinds.get(key)?.kind) kinds.set(key, { kind, format });
      let p = parameters.find((x) => x.name === key);
      if (!p) parameters.push((p = { name: key, values: { default: value } }));
      if (parameterValue(p, env) !== value) p.values[env] = value;
    }
  }
  for (const p of parameters) {
    const k = kinds.get(p.name);
    if (!k) continue;
    delete p.kind;
    delete p.format;
    if (k.kind) p.kind = k.kind;
    if (k.kind === 'date') Object.assign(p, formatField(k.format));
  }
  if (!parameters.some((p) => p.name === 'URL')) {
    parameters.unshift({ name: 'URL', values: { default: firstUrl ?? 'about:blank' } });
    warnings.push(firstUrl ? `URL parameter taken from the first opened page: ${firstUrl}` : 'No URL found; set the URL parameter in Parameters.');
  }
  if (!tests.length) warnings.push('No test cases found.');

  const project = ProjectSchema.parse({
    name: existing?.name ?? name,
    settings: existing?.settings ?? {},
    parameters,
    tests,
    keywords,
    generatedHashes: existing?.generatedHashes ?? {},
  });
  return { project, warnings };
}
