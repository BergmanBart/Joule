import type { Step } from './model';

/** Direct child lists of a step (group body, if then/else). */
export function childLists(step: Step): Step[][] {
  if (step.type === 'group') return [step.steps];
  if (step.type === 'if') return [step.then, step.else];
  return [];
}

export interface Walked {
  step: Step;
  depth: number;
  parent?: Step;
}

/** Depth-first walk over a step tree. */
export function* walk(steps: Step[], depth = 0, parent?: Step): Generator<Walked> {
  for (const step of steps) {
    yield { step, depth, parent };
    for (const list of childLists(step)) yield* walk(list, depth + 1, step);
  }
}

export function findStep(steps: Step[], id: string): Step | undefined {
  for (const { step } of walk(steps)) if (step.id === id) return step;
  return undefined;
}

/** Immutable map over every step in the tree (children are mapped before their parent). */
export function mapSteps(steps: Step[], fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    let next: Step = s;
    if (s.type === 'group') next = { ...s, steps: mapSteps(s.steps, fn) };
    else if (s.type === 'if') next = { ...s, then: mapSteps(s.then, fn), else: mapSteps(s.else, fn) };
    return fn(next);
  });
}

/** Immutable filter over the whole tree. */
export function filterSteps(steps: Step[], keep: (s: Step) => boolean): Step[] {
  return steps.filter(keep).map((s) => {
    if (s.type === 'group') return { ...s, steps: filterSteps(s.steps, keep) };
    if (s.type === 'if') return { ...s, then: filterSteps(s.then, keep), else: filterSteps(s.else, keep) };
    return s;
  });
}

/** Immutable replace of a single step by id. */
export function updateStep(steps: Step[], id: string, fn: (s: Step) => Step): Step[] {
  return mapSteps(steps, (s) => (s.id === id ? fn(s) : s));
}

/** All ids of a step and everything nested inside it. */
export function subtreeIds(step: Step): string[] {
  return [...walk([step])].map((w) => w.step.id);
}

/**
 * Keep only the selected steps (by id), preserving structure.
 * A selected container keeps all its children; an unselected group is flattened away,
 * an unselected if keeps its condition but only the selected branch steps.
 */
export function pickSteps(steps: Step[], selected: Set<string>): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (selected.has(s.id)) {
      out.push(s);
      continue;
    }
    if (s.type === 'group') {
      out.push(...pickSteps(s.steps, selected));
    } else if (s.type === 'if') {
      const then = pickSteps(s.then, selected);
      const els = pickSteps(s.else, selected);
      if (then.length || els.length) out.push({ ...s, then, else: els });
    }
  }
  return out;
}

/** Deep copy with fresh ids (for copy/paste). */
export function cloneWithNewIds(steps: Step[], newId: () => string): Step[] {
  return mapSteps(structuredClone(steps), (s) => ({ ...s, id: newId() }));
}

/** Order numbers for every non-group step, matching the badges in the browser view. */
export function numberSteps(steps: Step[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const { step } of walk(steps)) {
    if (step.type !== 'group') numbers.set(step.id, ++n);
  }
  return numbers;
}

/**
 * Move steps (by id) to a new position. `target` is the id of the list owner
 * ('root' or a group/if id, with ':then' / ':else' suffix for if branches) and `index` within it.
 */
export function moveSteps(steps: Step[], ids: string[], target: string, index: number): Step[] {
  const moving: Step[] = [];
  const idSet = new Set(ids);
  // collect in tree order, skipping steps nested in another moving step
  const collect = (list: Step[]) => {
    for (const s of list) {
      if (idSet.has(s.id)) moving.push(s);
      else for (const l of childLists(s)) collect(l);
    }
  };
  collect(steps);
  if (!moving.length) return steps;
  const movingIds = new Set(moving.flatMap(subtreeIds));
  if (target !== 'root' && movingIds.has(target.split(':')[0])) return steps; // cannot move into itself

  // Adjust the insert index for removed siblings that were before it in the same list.
  const targetList = target === 'root' ? steps : listById(steps, target);
  if (targetList) {
    const removedBefore = targetList.slice(0, index).filter((s) => idSet.has(s.id)).length;
    index -= removedBefore;
  }
  const remaining = filterSteps(steps, (s) => !idSet.has(s.id));
  return insertSteps(remaining, target, index, moving);
}

export function listById(steps: Step[], target: string): Step[] | undefined {
  if (target === 'root') return steps;
  const [id, branch] = target.split(':');
  const owner = findStep(steps, id);
  if (!owner) return undefined;
  if (owner.type === 'group') return owner.steps;
  if (owner.type === 'if') return branch === 'else' ? owner.else : owner.then;
  return undefined;
}

export function insertSteps(steps: Step[], target: string, index: number, items: Step[]): Step[] {
  const splice = (list: Step[]) => {
    const copy = [...list];
    copy.splice(Math.max(0, Math.min(index, copy.length)), 0, ...items);
    return copy;
  };
  if (target === 'root') return splice(steps);
  const [id, branch] = target.split(':');
  return mapSteps(steps, (s) => {
    if (s.id !== id) return s;
    if (s.type === 'group') return { ...s, steps: splice(s.steps) };
    if (s.type === 'if') return branch === 'else' ? { ...s, else: splice(s.else) } : { ...s, then: splice(s.then) };
    return s;
  });
}

/** Where a step lives: owner list id and index (inverse of insertSteps target). */
export function positionOf(steps: Step[], id: string, owner = 'root'): { target: string; index: number } | undefined {
  const index = steps.findIndex((s) => s.id === id);
  if (index >= 0) return { target: owner, index };
  for (const s of steps) {
    if (s.type === 'group') {
      const r = positionOf(s.steps, id, s.id);
      if (r) return r;
    } else if (s.type === 'if') {
      const r = positionOf(s.then, id, `${s.id}:then`) ?? positionOf(s.else, id, `${s.id}:else`);
      if (r) return r;
    }
  }
  return undefined;
}
