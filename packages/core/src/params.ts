import type { Environment, Parameter, ParameterKind, Project, Test } from './model';
import { dateFromExpression } from './date';
import { randomFromRegex } from './random';

export interface ResolvedParameter {
  name: string;
  value: string;
  /** The value as written: text with ${refs}, the regex of a random parameter or the expression of a date. */
  raw: string;
  kind: ParameterKind;
  source: 'project' | 'test';
  /** True when a test parameter overrides a project parameter with the same name. */
  shadowed: boolean;
  /** Why the value could not be fully resolved (invalid regex or date, circular reference). */
  error?: string;
}

export interface ResolveOptions {
  /** Random source used to draw random values. */
  random?: () => number;
  /** Clock for date parameters. */
  now?: Date;
  /** Earlier results: random parameters with the same name and regex keep their value. */
  reuse?: ResolvedParameter[];
}

const REF = /\$\{([^}]+)\}/g;

export function parameterValue(p: Parameter, env: Environment): string {
  const v = p.values[env];
  return v !== undefined && v !== '' ? v : p.values.default;
}

/** Random and date parameters: their value is computed when parameters are resolved and never references others. */
export function isComputed(p: Parameter): boolean {
  return p.kind === 'random' || p.kind === 'date';
}

/**
 * Parameters ordered so each one comes after the parameters of the same list it references.
 * `cyclic` maps the names on a reference cycle to a description of the cycle.
 */
export function referenceOrder(params: Parameter[], env: Environment): { order: Parameter[]; cyclic: Map<string, string> } {
  const byName = new Map(params.map((p) => [p.name, p]));
  const order: Parameter[] = [];
  const cyclic = new Map<string, string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (p: Parameter) => {
    if (done.has(p.name)) return;
    const at = stack.indexOf(p.name);
    if (at >= 0) {
      const cycle = [...stack.slice(at), p.name];
      for (const n of cycle) cyclic.set(n, `Circular reference: ${cycle.join(' → ')}`);
      return;
    }
    stack.push(p.name);
    if (!isComputed(p)) {
      for (const ref of parameterRefs(parameterValue(p, env))) {
        const dep = byName.get(ref);
        if (dep) visit(dep);
      }
    }
    stack.pop();
    done.add(p.name);
    order.push(p);
  };
  params.forEach(visit);
  return { order, cyclic };
}

/** Values of one list of parameters; references to names not in the list are looked up in `outer`. */
function resolveList(params: Parameter[], env: Environment, outer: Record<string, string>, opts: ResolveOptions) {
  const { order, cyclic } = referenceOrder(params, env);
  const own = new Set(params.map((p) => p.name));
  const values: Record<string, string> = {};
  const out = new Map<string, { value: string; raw: string; error?: string }>();
  for (const p of order) {
    const raw = parameterValue(p, env);
    if (p.kind === 'random') {
      const kept = opts.reuse?.find((r) => r.name === p.name && r.kind === 'random' && r.raw === raw && !r.error);
      try {
        values[p.name] = kept ? kept.value : randomFromRegex(raw, opts.random);
        out.set(p.name, { value: values[p.name], raw });
      } catch (e) {
        values[p.name] = '';
        out.set(p.name, { value: '', raw, error: `Invalid regex: ${(e as Error).message}` });
      }
      continue;
    }
    if (p.kind === 'date') {
      try {
        values[p.name] = dateFromExpression(raw, p.format, opts.now);
        out.set(p.name, { value: values[p.name], raw });
      } catch (e) {
        values[p.name] = '';
        out.set(p.name, { value: '', raw, error: `Invalid date: ${(e as Error).message}` });
      }
      continue;
    }
    values[p.name] = raw.replace(REF, (m, ref: string) => {
      if (own.has(ref)) return cyclic.has(ref) ? m : values[ref];
      return ref in outer ? outer[ref] : m;
    });
    out.set(p.name, { value: values[p.name], raw, error: cyclic.get(p.name) });
  }
  return { values, out };
}

/**
 * Test parameters win over project parameters; the current environment wins over default.
 * Values can reference other parameters as ${NAME}: project parameters only see project
 * parameters, test parameters see both. Random parameters get a new value on every call,
 * date parameters are computed from `opts.now` (default: the current time).
 */
export function resolveParameters(project: Project, test?: Test, env: Environment = project.settings.environment, opts: ResolveOptions = {}): ResolvedParameter[] {
  const fromProject = resolveList(project.parameters, env, {}, opts);
  const fromTest = resolveList(test?.parameters ?? [], env, fromProject.values, opts);
  const out = new Map<string, ResolvedParameter>();
  for (const p of project.parameters) {
    const r = fromProject.out.get(p.name)!;
    out.set(p.name, { name: p.name, ...r, kind: p.kind ?? 'text', source: 'project', shadowed: false });
  }
  for (const p of test?.parameters ?? []) {
    const r = fromTest.out.get(p.name)!;
    out.set(p.name, { name: p.name, ...r, kind: p.kind ?? 'text', source: 'test', shadowed: out.has(p.name) });
  }
  return [...out.values()];
}

/** Replace ${name} references; unknown names are left untouched. */
export function interpolate(text: string, params: ResolvedParameter[] | Record<string, string>): string {
  const lookup = Array.isArray(params) ? Object.fromEntries(params.map((p) => [p.name, p.value])) : params;
  return text.replace(REF, (m, name: string) => (name in lookup ? lookup[name] : m));
}

export function parameterRefs(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[1]);
}
