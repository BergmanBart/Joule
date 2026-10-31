/** WebSocket protocol between the UI and the server. Shared so both sides stay in sync. */
import type { CustomKeyword } from './custom';
import type { BrowserName, ElementDescriptor, Environment, Project } from './model';

export interface AppSettings {
  recent: string[];
  pythonPath?: string;
  lastProject?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isProject: boolean;
}

export interface HighlightRequest {
  n: number;
  selector: string;
  kind: 'normal' | 'selected' | 'dim' | 'running';
  all?: boolean;
}

export interface DepsInfo {
  python?: { path: string; version: string };
  robot?: string;
  browser?: string;
  browserInit: boolean;
  pabot?: string;
  ok: boolean;
  installCommands: string[];
}

export interface RobotTestResult {
  testId?: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'NOT RUN';
  message: string;
}

/** request type → [payload, result] */
export interface Requests {
  'app.state': [{}, { settings: AppSettings; projectDir?: string; project?: Project; externalEdits: string[]; home: string; cwd: string }];
  'app.saveSettings': [{ settings: AppSettings }, AppSettings];
  'fs.list': [{ dir: string }, { dir: string; parent?: string; entries: FsEntry[] }];
  'fs.mkdir': [{ dir: string }, { dir: string }];
  'project.create': [{ dir: string; name: string; url: string }, { dir: string; project: Project }];
  'project.open': [{ dir: string }, { dir: string; project: Project; externalEdits: string[]; imported: boolean; warnings: string[] }];
  'project.save': [{ project: Project }, Project];
  'project.reimport': [{}, { project: Project; warnings: string[] }];
  /** Keywords in <project>/custom_keywords. */
  'keywords.scan': [{}, { keywords: CustomKeyword[]; warnings: string[] }];
  'view.start': [{ browser: BrowserName; width: number; height: number; url: string }, {}];
  'view.navigate': [{ url: string }, {}];
  'view.reload': [{}, {}];
  'view.back': [{}, {}];
  /** Fresh browser context (no cookies or storage), then open `url`. */
  'view.reset': [{ url: string }, {}];
  'view.mode': [{ mode: 'record' | 'interact' }, {}];
  'view.mouse': [{ type: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; deltaX?: number; deltaY?: number }, {}];
  'view.key': [{ type: 'down' | 'up' | 'text'; key?: string; text?: string }, {}];
  'view.highlights': [{ items: HighlightRequest[] }, {}];
  'view.count': [{ selector: string }, { count: number; error?: string }];
  'view.pickConstraint': [{ constraint: { selector: string; relation: 'ancestor' | 'descendant' } | null }, { found: boolean }];
  'view.describeParent': [{ selector: string }, { descriptor?: ElementDescriptor }];
  /** The client drew the last frame it was sent and can take the next one. */
  'view.frameDrawn': [{}, {}];
  /**
   * How the client shows the browser view: not at all (minimized, another tab in front) or at what size in device
   * pixels. The browser streams while some client shows the view, scaled down to the largest size one shows it at.
   */
  'view.display': [{ visible: boolean; width: number; height: number }, {}];
  /** `params`: resolved parameter values to use (the ones the browser view shows); resolved fresh when missing. */
  'run.live': [{ project: Project; testId: string; stepIds?: string[]; fromStart: boolean; params?: Record<string, string> }, {}];
  'run.robot': [{ project: Project; testIds?: string[]; headless?: boolean; parallel?: boolean }, {}];
  'run.continue': [{}, {}];
  'run.stop': [{}, {}];
  'deps.check': [{}, DepsInfo];
  'deps.install': [{ skipBrowsers: boolean }, { ok: boolean }];
}

export type RequestType = keyof Requests;

/**
 * Server → client JSON events. Frames of the browser view are binary messages instead: the page width and height
 * (uint16, big-endian) followed by the JPEG. After drawing one the client sends `view.frameDrawn` for the next.
 */
export interface Events {
  'view.pick': { descriptor: ElementDescriptor };
  'view.url': { url: string };
  'view.status': { state: 'starting' | 'ready' | 'closed' | 'error'; message?: string };
  'run.started': { kind: 'live' | 'robot'; testIds: string[] };
  'run.step': { id: string; status: 'running' | 'pass' | 'fail' | 'skip'; message?: string; ms?: number };
  'run.output': { line: string };
  'run.paused': { stepId?: string; message?: string };
  'run.resumed': {};
  'run.done': { kind: 'live' | 'robot'; ok: boolean; logDir?: string; results?: RobotTestResult[]; message?: string };
  'deps.output': { line: string };
  'project.changedOnDisk': { files: string[] };
}

export type EventType = keyof Events;

export type ClientMessage = { id: number; type: RequestType; payload: unknown };
export type ServerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { event: EventType; data: unknown };

export type { Environment };
