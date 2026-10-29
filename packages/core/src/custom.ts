/**
 * Custom keywords: Robot Framework keywords the user keeps in <project>/custom_keywords.
 * They are scanned from disk (see engine/parse_robot.py), never stored in joule.json.
 */
import type { CustomCallStep } from './model';

/** Keep in sync with CUSTOM_DIR in engine/src/parse_robot.py. */
export const CUSTOM_KEYWORDS_DIR = 'custom_keywords';

export interface CustomKeywordArg {
  name: string;
  /** arg: positional or named, named: named-only (after @{} or @{rest}), varargs: @{rest}, kwargs: &{rest} */
  kind: 'arg' | 'named' | 'varargs' | 'kwargs';
  default?: string;
  /** Type hint as written, e.g. `int` or `Literal['fast', 'slow']` (Robot Framework 7.3+). */
  type?: string;
  /** Allowed values, from a Literal[...] or bool type hint. */
  options?: string[];
  /** The type allows None, so leaving the argument out is fine. */
  optional?: boolean;
}

export interface CustomKeyword {
  name: string;
  /** Project relative file, e.g. custom_keywords/login/login.resource */
  source: string;
  doc: string;
  args: CustomKeywordArg[];
}

/** One file as printed by parse_robot.py. */
export interface ParsedCustomFile {
  file: string;
  error?: string;
  keywords: { name: string; doc: string; args: string[] }[];
}

/** Items of `Literal['a', "b", 3]`. */
function literalItems(body: string): string[] {
  const items: string[] = [];
  for (const m of body.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,\s][^,]*)/g)) {
    const v = m[1] ?? m[2] ?? m[3]?.trim();
    if (v !== undefined) items.push(v.replace(/\\(.)/g, '$1'));
  }
  return items;
}

/** Dropdown values for a type hint; `optional` when None is part of the union. */
export function typeOptions(type: string): { options?: string[]; optional: boolean } {
  const parts = type.split('|').map((p) => p.trim());
  const optional = parts.some((p) => /^none$/i.test(p));
  const options: string[] = [];
  for (const p of parts) {
    const lit = /^(?:typing\.)?Literal\[(.*)\]$/s.exec(p);
    if (lit) options.push(...literalItems(lit[1]));
    else if (/^(bool|boolean)$/i.test(p)) options.push('True', 'False');
    else if (!/^none$/i.test(p)) return { optional }; // a free-form type in the union: plain text field
  }
  return { options: options.length ? [...new Set(options)] : undefined, optional };
}

/** Parse the cells of a keyword's [Arguments] setting. */
export function parseArguments(raw: string[]): CustomKeywordArg[] {
  const args: CustomKeywordArg[] = [];
  let namedOnly = false;
  for (const cell of raw) {
    const m = /^([$@&])\{([^}]*)\}(?:=(.*))?$/s.exec(cell.trim());
    if (!m) continue;
    const [, sigil, inner, def] = m;
    const colon = inner.indexOf(':');
    const name = (colon >= 0 ? inner.slice(0, colon) : inner).trim();
    const type = colon >= 0 ? inner.slice(colon + 1).trim() || undefined : undefined;
    if (sigil === '@') {
      namedOnly = true;
      if (name) args.push({ name, kind: 'varargs', type });
      continue;
    }
    if (!name) continue;
    if (sigil === '&') {
      args.push({ name, kind: 'kwargs', type });
      continue;
    }
    const arg: CustomKeywordArg = { name, kind: namedOnly ? 'named' : 'arg' };
    if (def !== undefined) arg.default = def;
    if (type) {
      arg.type = type;
      const t = typeOptions(type);
      if (t.options) arg.options = t.options;
      if (t.optional) arg.optional = true;
    }
    args.push(arg);
  }
  return args;
}

export function customKeywordsFrom(files: ParsedCustomFile[]): { keywords: CustomKeyword[]; warnings: string[] } {
  const keywords: CustomKeyword[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (f.error) warnings.push(`${f.file}: ${f.error}`);
    for (const k of f.keywords) keywords.push({ name: k.name, source: f.file, doc: k.doc, args: parseArguments(k.args) });
  }
  return { keywords, warnings };
}

export const normalizeKeywordName = (name: string) => name.toLowerCase().replace(/[\s_]/g, '');

/** The definition a call refers to: same file and name, or (file moved) the same name elsewhere. */
export function findCustomKeyword(defs: CustomKeyword[], step: Pick<CustomCallStep, 'keyword' | 'source'>): CustomKeyword | undefined {
  const name = normalizeKeywordName(step.keyword);
  const same = defs.filter((d) => normalizeKeywordName(d.name) === name);
  return same.find((d) => d.source === step.source) ?? same[0];
}

/** Required: no default and None not allowed. Varargs and kwargs never are. */
export function isRequired(a: CustomKeywordArg): boolean {
  return (a.kind === 'arg' || a.kind === 'named') && a.default === undefined && !a.optional;
}
