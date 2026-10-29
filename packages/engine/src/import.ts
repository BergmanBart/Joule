import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importParsed, type ParsedFolder, type Project } from '@joule/core';
import { exec } from './python';

const PARSER = fileURLToPath(new URL('./parse_robot.py', import.meta.url));

/** Parse every .robot/.resource file in a folder with Robot Framework's own parser. */
export async function parseFolder(dir: string, python: string): Promise<ParsedFolder> {
  const r = await exec(python, [PARSER, dir]);
  if (r.code !== 0) throw new Error(`Could not parse Robot files: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return JSON.parse(r.stdout) as ParsedFolder;
}

/** Open a folder of Robot files as a Joule project (best effort), or re-read a Joule project edited by hand. */
export async function importFolder(dir: string, python: string, existing?: Project): Promise<{ project: Project; warnings: string[] }> {
  return importParsed(await parseFolder(dir, python), basename(dir), existing);
}
