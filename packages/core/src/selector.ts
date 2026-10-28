import type { ElementDescriptor, Locator } from './model';

const SIMPLE_IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function cssIdent(value: string): string {
  return SIMPLE_IDENT.test(value) ? value : value.replace(/([^_a-zA-Z0-9-])/g, '\\$1');
}

export interface SelectorProp {
  key: string;
  label: string;
  value: string;
}

/** The selector properties a user can toggle for an element, in display order. */
export function availableProps(d: ElementDescriptor): SelectorProp[] {
  const out: SelectorProp[] = [{ key: 'tag', label: 'tag', value: d.tag }];
  if (d.id) out.push({ key: 'id', label: 'id', value: d.id });
  for (const c of d.classes) out.push({ key: `class:${c}`, label: 'class', value: c });
  for (const [name, value] of Object.entries(d.attributes)) {
    if (name === 'id' || name === 'class' || name === 'style') continue;
    out.push({ key: `attr:${name}`, label: name, value });
  }
  if (d.text) out.push({ key: 'text', label: 'text', value: d.text });
  if (d.cssPath) out.push({ key: 'css', label: 'css path', value: d.cssPath });
  if (d.xpath) out.push({ key: 'xpath', label: 'xpath', value: d.xpath });
  return out;
}

const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
const NICE_ATTRS = ['name', 'aria-label', 'placeholder', 'title', 'for', 'href', 'type'];

/** Pick a sensible default set of properties for a freshly recorded element. */
export function defaultUse(d: ElementDescriptor): string[] {
  for (const attr of TEST_ATTRS) if (d.attributes[attr]) return ['tag', `attr:${attr}`];
  if (d.id && !/\d{3,}/.test(d.id)) return ['tag', 'id'];
  const shortText = d.text && d.text.length <= 40;
  for (const attr of NICE_ATTRS) {
    if (d.attributes[attr]) return shortText && attr === 'type' ? ['tag', `attr:${attr}`, 'text'] : ['tag', `attr:${attr}`];
  }
  if (shortText) return ['tag', 'text'];
  return d.cssPath ? ['css'] : ['tag'];
}

/**
 * Build a Robot Framework Browser library (Playwright) selector from the toggled properties.
 * xpath / css path / custom are exclusive; everything else is combined into one css selector.
 */
export function buildSelector(loc: Locator): string {
  if (loc.custom && loc.custom.trim()) return loc.custom.trim();
  const d = loc.props;
  const use = new Set(loc.use);
  if (use.has('xpath') && d.xpath) return `xpath=${d.xpath}`;
  if (use.has('css') && d.cssPath) return `css=${d.cssPath}`;

  let css = use.has('tag') ? d.tag.toLowerCase() : '';
  if (use.has('id') && d.id) css += SIMPLE_IDENT.test(d.id) ? `#${d.id}` : `[id=${cssString(d.id)}]`;
  for (const key of loc.use) {
    if (key.startsWith('class:')) css += `.${cssIdent(key.slice(6))}`;
    else if (key.startsWith('attr:')) {
      const name = key.slice(5);
      const value = d.attributes[name];
      css += value === undefined || value === '' ? `[${name}]` : `[${name}=${cssString(value)}]`;
    }
  }
  if (use.has('text') && d.text) css += `:text-is(${cssString(d.text)})`;
  return `css=${css || '*'}`;
}
