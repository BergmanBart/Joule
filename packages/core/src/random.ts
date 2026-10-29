/**
 * Random strings from a regular expression. The same subset is implemented in Python for the
 * generated Robot files (JouleLib.py); keep the character sets and the repeat cap in sync.
 */

/** `*`, `+` and `{n,}` repeat at most this many times more than their minimum. */
export const REPEAT_CAP = 8;

const PRINTABLE = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
const DIGIT = PRINTABLE.filter((c) => c >= '0' && c <= '9');
const WORD = PRINTABLE.filter((c) => /\w/.test(c));
const SPACE = [' '];
const not = (chars: string[]) => PRINTABLE.filter((c) => !chars.includes(c));
const CLASSES: Record<string, string[]> = { d: DIGIT, D: not(DIGIT), w: WORD, W: not(WORD), s: SPACE, S: not(SPACE) };
const CONTROL: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', '0': '\0' };

type Node =
  | { t: 'empty' }
  | { t: 'set'; chars: string[] }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; options: Node[] }
  | { t: 'group'; n?: number; body: Node }
  | { t: 'rep'; min: number; max: number; body: Node }
  | { t: 'ref'; n: number };

const lit = (c: string): Node => ({ t: 'set', chars: [c] });

class Parser {
  private i = 0;
  private groups = 0;
  constructor(private s: string) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.s.length) throw this.err('Unmatched ")"');
    return node;
  }

  private err(message: string): Error {
    return new Error(`${message} at position ${this.i + 1}`);
  }

  private alt(): Node {
    const options = [this.seq()];
    while (this.s[this.i] === '|') {
      this.i++;
      options.push(this.seq());
    }
    return options.length === 1 ? options[0] : { t: 'alt', options };
  }

  private seq(): Node {
    const items: Node[] = [];
    while (this.i < this.s.length && this.s[this.i] !== '|' && this.s[this.i] !== ')') {
      const atom = this.atom();
      const q = this.quantifier();
      if (!q) {
        items.push(atom);
        continue;
      }
      if (atom.t === 'empty') throw this.err('Nothing to repeat');
      if (this.s[this.i] === '?') this.i++; // lazy: same strings
      if (this.peekQuantifier()) throw this.err('Multiple repeat');
      items.push({ t: 'rep', min: q[0], max: q[1], body: atom });
    }
    return { t: 'seq', items };
  }

  private peekQuantifier(): boolean {
    const start = this.i;
    const q = this.quantifier();
    this.i = start;
    return q !== null;
  }

  private quantifier(): [number, number] | null {
    const c = this.s[this.i];
    if (c === '*' || c === '+' || c === '?') {
      this.i++;
      return c === '*' ? [0, Infinity] : c === '+' ? [1, Infinity] : [0, 1];
    }
    if (c !== '{') return null;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i));
    if (!m) return null; // a literal {
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    if (max < min) throw this.err('Bad repeat range');
    this.i += m[0].length;
    return [min, max];
  }

  private atom(): Node {
    const c = this.s[this.i++];
    switch (c) {
      case '(':
        return this.group();
      case '[':
        return this.charClass();
      case '.':
        return { t: 'set', chars: PRINTABLE };
      case '^':
      case '$':
        return { t: 'empty' };
      case '\\':
        return this.escape();
      case '*':
      case '+':
      case '?':
        this.i--;
        throw this.err('Nothing to repeat');
      case '{':
        this.i--;
        if (this.peekQuantifier()) throw this.err('Nothing to repeat');
        this.i++;
        return lit(c);
      default:
        return lit(c);
    }
  }

  private group(): Node {
    let n: number | undefined;
    if (this.s[this.i] === '?') {
      const rest = this.s.slice(this.i + 1);
      const named = /^P?<([A-Za-z_]\w*)>/.exec(rest);
      if (rest.startsWith(':')) this.i += 2;
      else if (named) {
        this.i += 1 + named[0].length;
        n = ++this.groups;
      } else throw this.err(`Unsupported group "(?${rest.slice(0, 2)}"`);
    } else n = ++this.groups;
    const body = this.alt();
    if (this.s[this.i] !== ')') throw this.err('Missing ")"');
    this.i++;
    return { t: 'group', n, body };
  }

  /** Characters of one escape (`\d`, `\n`, `\x41`, `\.`); `inClass` decides what \b means. */
  private escapeChars(inClass: boolean): string[] | Node {
    const d = this.s[this.i++];
    if (d === undefined) throw this.err('Trailing backslash');
    if (d in CLASSES) return CLASSES[d];
    if (d in CONTROL) return [CONTROL[d]];
    if (d === 'x' || d === 'u') {
      const len = d === 'x' ? 2 : 4;
      const hex = this.s.slice(this.i, this.i + len);
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) throw this.err(`Bad \\${d} escape`);
      this.i += len;
      return [String.fromCharCode(parseInt(hex, 16))];
    }
    if (d === 'b' && inClass) return ['\b'];
    if (!inClass && (d === 'b' || d === 'B')) return { t: 'empty' };
    if (!inClass && /[1-9]/.test(d)) {
      const m = /^\d*/.exec(this.s.slice(this.i))!;
      const n = Number(d + m[0]);
      if (n > this.groups) throw this.err(`Unknown group \\${n}`);
      this.i += m[0].length;
      return { t: 'ref', n };
    }
    if (/[A-Za-z0-9]/.test(d)) throw this.err(`Unsupported escape \\${d}`);
    return [d];
  }

  private escape(): Node {
    const r = this.escapeChars(false);
    return Array.isArray(r) ? { t: 'set', chars: r } : r;
  }

  private charClass(): Node {
    const negate = this.s[this.i] === '^';
    if (negate) this.i++;
    const chars = new Set<string>();
    const item = (): string[] => {
      const c = this.s[this.i++];
      if (c !== '\\') return [c];
      return this.escapeChars(true) as string[];
    };
    let first = true;
    while (this.s[this.i] !== ']' || first) {
      if (this.i >= this.s.length) throw this.err('Missing "]"');
      first = false;
      const from = item();
      if (from.length === 1 && this.s[this.i] === '-' && this.i + 1 < this.s.length && this.s[this.i + 1] !== ']') {
        this.i++;
        const to = item();
        if (to.length !== 1) throw this.err('Bad character range');
        const [a, b] = [from[0].charCodeAt(0), to[0].charCodeAt(0)];
        if (a > b) throw this.err('Bad character range');
        for (let code = a; code <= b; code++) chars.add(String.fromCharCode(code));
      } else from.forEach((c) => chars.add(c));
    }
    this.i++;
    const list = negate ? PRINTABLE.filter((c) => !chars.has(c)) : [...chars];
    if (!list.length) throw this.err('Character class matches nothing');
    return { t: 'set', chars: list };
  }
}

function pick<T>(items: T[], rnd: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rnd() * items.length))];
}

function generate(node: Node, rnd: () => number, groups: string[]): string {
  switch (node.t) {
    case 'empty':
      return '';
    case 'set':
      return pick(node.chars, rnd);
    case 'seq':
      return node.items.map((n) => generate(n, rnd, groups)).join('');
    case 'alt':
      return generate(pick(node.options, rnd), rnd, groups);
    case 'group': {
      const value = generate(node.body, rnd, groups);
      if (node.n !== undefined) groups[node.n] = value;
      return value;
    }
    case 'rep': {
      const max = node.max === Infinity ? node.min + REPEAT_CAP : node.max;
      const count = node.min + Math.min(max - node.min, Math.floor(rnd() * (max - node.min + 1)));
      let out = '';
      for (let k = 0; k < count; k++) out += generate(node.body, rnd, groups);
      return out;
    }
    case 'ref':
      return groups[node.n] ?? '';
  }
}

/** A random string matching `pattern`; throws on syntax that is invalid or not supported (lookarounds, flags). */
export function randomFromRegex(pattern: string, rnd: () => number = Math.random): string {
  return generate(new Parser(pattern).parse(), rnd, []);
}

/** Why `pattern` cannot be used for random values, or undefined when it can. */
export function regexError(pattern: string): string | undefined {
  try {
    new Parser(pattern).parse();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
