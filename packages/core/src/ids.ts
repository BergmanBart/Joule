let counter = 0;

/** Short unique id; good enough for steps/tests inside one project file. */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${rand}`;
}
