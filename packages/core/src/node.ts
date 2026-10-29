/** Node-only entry: project load/save on disk. Keep fs out of the browser bundle. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { CUSTOM_KEYWORDS_DIR } from './custom';
import { Project } from './model';
import { generateRobotFiles } from './robot/generate';

export const PROJECT_FILE = 'joule.json';
/** Projects made before the rename to Joule. Read as-is; the next save writes joule.json and cleans up. */
const LEGACY_PROJECT_FILE = 'uitester.json';

export function sha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, PROJECT_FILE)) || existsSync(join(dir, LEGACY_PROJECT_FILE));
}

export async function loadProject(dir: string): Promise<Project> {
  const file = existsSync(join(dir, PROJECT_FILE)) ? PROJECT_FILE : LEGACY_PROJECT_FILE;
  const raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
  return Project.parse(raw);
}

/**
 * Write joule.json and all generated Robot Framework files.
 * Generated files from a previous save that are no longer produced (e.g. a deleted test) are removed,
 * but only when nobody edited them since.
 */
export async function saveProject(dir: string, project: Project): Promise<Project> {
  const files = generateRobotFiles(project);
  const hashes: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    hashes[rel] = sha256(content);
  }
  for (const [rel, oldHash] of Object.entries(project.generatedHashes)) {
    if (rel in files) continue;
    const path = join(dir, rel);
    if (existsSync(path) && sha256(await readFile(path, 'utf8')) === oldHash) await rm(path);
  }
  const saved: Project = { ...project, generatedHashes: hashes };
  const shots = saved.settings.screenshotDir;
  await mkdir(isAbsolute(shots) ? shots : join(dir, shots), { recursive: true });
  // where users drop their own keyword files (shown under Reusable keywords → Custom Keywords)
  await mkdir(join(dir, CUSTOM_KEYWORDS_DIR), { recursive: true });
  await writeFile(join(dir, PROJECT_FILE), JSON.stringify(saved, null, 2) + '\n', 'utf8');
  // Old generated helpers (uitester.resource, UITesterLib.py) went with the stale-file cleanup above.
  await rm(join(dir, LEGACY_PROJECT_FILE), { force: true });
  return saved;
}

/** Generated files changed outside Joule since the last save. */
export async function externallyEdited(dir: string, project: Project): Promise<string[]> {
  const changed: string[] = [];
  for (const [rel, hash] of Object.entries(project.generatedHashes)) {
    const path = join(dir, rel);
    if (existsSync(path) && sha256(await readFile(path, 'utf8')) !== hash) changed.push(rel);
  }
  return changed;
}
