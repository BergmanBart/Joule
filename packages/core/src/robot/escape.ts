/** Argument names of the keywords we generate; `name=value` positional values with these prefixes need `\=`. */
const ARG_NAMES = new Set(
  [
    'selector', 'txt', 'text', 'button', 'clickCount', 'attribute', 'values', 'keys', 'key', 'value', 'name',
    'assertion_operator', 'assertion_expected', 'message', 'filename', 'fullPage', 'timeout', 'state',
    'property', 'delay', 'clear', 'modifiers', 'force', 'noWaitAfter', 'position_x', 'position_y', 'url',
  ].map((n) => n.toLowerCase()),
);

/** Escape a value so Robot Framework reads it back as exactly one argument. ${vars} stay live. */
export function arg(value: string): string {
  if (value === '') return '${EMPTY}';
  let s = value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
  s = s.replace(/ {2,}/g, (m) => ' ' + '${SPACE}'.repeat(m.length - 1));
  if (s.startsWith(' ')) s = '${SPACE}' + s.slice(1);
  if (s.endsWith(' ')) s = s.slice(0, -1) + '${SPACE}';
  if (s.startsWith('#')) s = '\\' + s;
  const named = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(s);
  if (named && ARG_NAMES.has(named[1].toLowerCase())) s = s.replace('=', '\\=');
  return s;
}

/** Undo `arg` (used by the importer). */
export function unarg(value: string): string {
  if (value === '${EMPTY}') return '';
  return value
    .replace(/\$\{SPACE\}/g, ' ')
    .replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** Join cells with the 4-space separator Robot Framework expects. */
export function row(...cells: string[]): string {
  return cells.join('    ');
}

/** Name usable as a Robot test or keyword name (no separators, no leading/trailing space). */
export function robotName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().replace(/^#/, '\\#') || 'Unnamed';
}

/** File-system safe base name; Robot turns underscores back into spaces for the suite name. */
export function fileName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_') || 'Test';
}

/** Suite name Robot derives from a file base name (underscores → spaces, all-lowercase → Title Case). */
export function suiteNameFromFile(base: string): string {
  const name = base.replace(/^\d+__/, '').replace(/_/g, ' ');
  return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
}
