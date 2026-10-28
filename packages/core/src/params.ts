import type { Environment, Parameter, Project, Test } from './model';

export interface ResolvedParameter {
  name: string;
  value: string;
  source: 'project' | 'test';
  /** True when a test parameter overrides a project parameter with the same name. */
  shadowed: boolean;
}

export function parameterValue(p: Parameter, env: Environment): string {
  const v = p.values[env];
  return v !== undefined && v !== '' ? v : p.values.default;
}

/** Test parameters win over project parameters; the current environment wins over default. */
export function resolveParameters(project: Project, test?: Test, env: Environment = project.settings.environment): ResolvedParameter[] {
  const out = new Map<string, ResolvedParameter>();
  for (const p of project.parameters) {
    out.set(p.name, { name: p.name, value: parameterValue(p, env), source: 'project', shadowed: false });
  }
  for (const p of test?.parameters ?? []) {
    out.set(p.name, { name: p.name, value: parameterValue(p, env), source: 'test', shadowed: out.has(p.name) });
  }
  return [...out.values()];
}

/** Replace ${name} references; unknown names are left untouched. */
export function interpolate(text: string, params: ResolvedParameter[] | Record<string, string>): string {
  const lookup = Array.isArray(params) ? Object.fromEntries(params.map((p) => [p.name, p.value])) : params;
  return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => (name in lookup ? lookup[name] : m));
}

export function parameterRefs(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
}
