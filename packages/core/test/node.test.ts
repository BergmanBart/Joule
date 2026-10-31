import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProject, newTest, Project, testFileName } from '../src';
import { PROJECT_FILE, saveProject } from '../src/node';

describe('saving', () => {
  it('rewrites only the files whose content changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joule-save-'));
    const p = newProject('Save', 'https://example.com');
    p.tests.push(newTest('Second'));
    const saved = await saveProject(dir, Project.parse(p));
    const files = [...Object.keys(saved.generatedHashes), PROJECT_FILE];
    const mtimes = async () => Object.fromEntries(await Promise.all(files.map(async (f) => [f, (await stat(join(dir, f))).mtimeMs] as const)));
    const changedSince = async (before: Record<string, number>) => {
      const after = await mtimes();
      return files.filter((f) => after[f] !== before[f]);
    };

    let before = await mtimes();
    await new Promise((r) => setTimeout(r, 50));
    const second = { ...saved.tests[1], steps: [{ id: 'w1', name: '', type: 'wait' as const, wait: { kind: 'time' as const, seconds: 1 } }] };
    const edited = await saveProject(dir, { ...saved, tests: [saved.tests[0], second] });
    expect(await changedSince(before)).toEqual([testFileName(edited, second), PROJECT_FILE]);

    before = await mtimes();
    await new Promise((r) => setTimeout(r, 50));
    await saveProject(dir, edited);
    expect(await changedSince(before)).toEqual([]);
  });
});
