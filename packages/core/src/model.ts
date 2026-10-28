import { z } from 'zod';

export const ENVIRONMENTS = ['DEV', 'TEST', 'ACC', 'PROD'] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;

export const BROWSERS = ['chromium', 'msedge', 'firefox'] as const;
export const BrowserName = z.enum(BROWSERS);
export type BrowserName = z.infer<typeof BrowserName>;

// ---------- Parameters ----------

export const ParameterValues = z.object({
  default: z.string().default(''),
  DEV: z.string().optional(),
  TEST: z.string().optional(),
  ACC: z.string().optional(),
  PROD: z.string().optional(),
});
export type ParameterValues = z.infer<typeof ParameterValues>;

export const Parameter = z.object({
  name: z.string().min(1),
  values: ParameterValues,
});
export type Parameter = z.infer<typeof Parameter>;

// ---------- Element locating ----------

/** Everything captured about an element when it was clicked in the browser view. */
export const ElementDescriptor = z.object({
  tag: z.string(),
  id: z.string().optional(),
  classes: z.array(z.string()).default([]),
  attributes: z.record(z.string()).default({}),
  text: z.string().optional(),
  role: z.string().optional(),
  xpath: z.string().optional(),
  cssPath: z.string().optional(),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

/**
 * Which descriptor properties are used to find the element.
 * Keys: 'tag' | 'id' | 'text' | 'xpath' | 'css' | 'class:<name>' | 'attr:<name>'
 * A `custom` selector, when set, wins over everything else.
 */
export const Locator = z.object({
  props: ElementDescriptor,
  use: z.array(z.string()).default([]),
  custom: z.string().optional(),
});
export type Locator = z.infer<typeof Locator>;

// ---------- Actions & assertions ----------

export const ACTION_KINDS = ['click', 'dblclick', 'rightclick', 'fill', 'hover', 'select', 'check', 'uncheck', 'press'] as const;
export const ActionKind = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKind>;

export const Action = z.object({
  kind: ActionKind,
  /** Text for fill, option value for select, key for press. May contain ${param}. */
  value: z.string().optional(),
});
export type Action = z.infer<typeof Action>;

export const ASSERT_PROPERTIES = ['text', 'value', 'attribute', 'count', 'state'] as const;
export const AssertProperty = z.enum(ASSERT_PROPERTIES);
export type AssertProperty = z.infer<typeof AssertProperty>;

export const OPERATORS = ['==', '!=', 'contains', 'not contains', 'starts', 'ends', 'matches', '>', '<', '>=', '<='] as const;
export const Operator = z.enum(OPERATORS);
export type Operator = z.infer<typeof Operator>;

export const Assertion = z.object({
  property: AssertProperty,
  /** Attribute name when property = attribute. */
  name: z.string().optional(),
  operator: Operator.default('=='),
  /** Expected value; may contain ${param}. For state: visible|hidden|enabled|disabled|checked|unchecked|editable. */
  expected: z.string().default(''),
});
export type Assertion = z.infer<typeof Assertion>;

// ---------- Steps ----------

const base = {
  id: z.string(),
  name: z.string().default(''),
};

export const ElementStep = z.object({
  ...base,
  type: z.literal('element'),
  mode: z.enum(['action', 'assert']),
  locator: Locator,
  action: Action.optional(),
  assertion: Assertion.optional(),
});
export type ElementStep = z.infer<typeof ElementStep>;

export const WaitStep = z.object({
  ...base,
  type: z.literal('wait'),
  wait: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('time'), seconds: z.number().nonnegative() }),
    z.object({ kind: z.literal('load'), state: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load') }),
    z.object({
      kind: z.literal('element'),
      locator: Locator,
      state: z.enum(['visible', 'hidden', 'attached', 'detached', 'enabled']).default('visible'),
      timeoutSeconds: z.number().positive().optional(),
    }),
  ]),
});
export type WaitStep = z.infer<typeof WaitStep>;

export const PauseStep = z.object({ ...base, type: z.literal('pause'), message: z.string().optional() });
export type PauseStep = z.infer<typeof PauseStep>;

export const ScreenshotStep = z.object({
  ...base,
  type: z.literal('screenshot'),
  filename: z.string().default('screenshot'),
  fullPage: z.boolean().default(false),
});
export type ScreenshotStep = z.infer<typeof ScreenshotStep>;

export const KeywordCallStep = z.object({ ...base, type: z.literal('keywordCall'), keywordId: z.string() });
export type KeywordCallStep = z.infer<typeof KeywordCallStep>;

export const RawStep = z.object({ ...base, type: z.literal('raw'), lines: z.array(z.string()) });
export type RawStep = z.infer<typeof RawStep>;

/** Condition of an if step: an assertion on an element. */
export const Condition = z.object({ locator: Locator, assertion: Assertion });
export type Condition = z.infer<typeof Condition>;

export type GroupStep = { id: string; name: string; type: 'group'; collapsed: boolean; steps: Step[] };
export type IfStep = { id: string; name: string; type: 'if'; condition: Condition; then: Step[]; else: Step[] };

export type Step = ElementStep | WaitStep | PauseStep | ScreenshotStep | KeywordCallStep | RawStep | GroupStep | IfStep;
export type StepType = Step['type'];

export const Step: z.ZodType<Step, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([ElementStep, WaitStep, PauseStep, ScreenshotStep, KeywordCallStep, RawStep, GroupStep, IfStep]),
);

export const GroupStep: z.ZodType<GroupStep, z.ZodTypeDef, unknown> = z.object({
  ...base,
  type: z.literal('group'),
  collapsed: z.boolean().default(false),
  steps: z.array(z.lazy(() => Step)).default([]),
});

export const IfStep: z.ZodType<IfStep, z.ZodTypeDef, unknown> = z.object({
  ...base,
  type: z.literal('if'),
  condition: Condition,
  then: z.array(z.lazy(() => Step)).default([]),
  else: z.array(z.lazy(() => Step)).default([]),
});

// ---------- Tests, keywords, project ----------

export const Test = z.object({
  id: z.string(),
  name: z.string().min(1),
  flow: z.enum(['happy', 'unhappy']).default('happy'),
  kind: z.enum(['smoke', 'regression']).default('regression'),
  parameters: z.array(Parameter).default([]),
  steps: z.array(Step).default([]),
});
export type Test = z.infer<typeof Test>;

/** A reusable (linked) group, generated as a user keyword in resources/keywords.resource. */
export const Keyword = z.object({
  id: z.string(),
  name: z.string().min(1),
  steps: z.array(Step).default([]),
});
export type Keyword = z.infer<typeof Keyword>;

/** Run plan: stages run in series, the tests inside one stage run in parallel. */
export const Stage = z.object({ tests: z.array(z.string()).default([]) });
export type Stage = z.infer<typeof Stage>;

export const Settings = z.object({
  browser: BrowserName.default('chromium'),
  headless: z.boolean().default(false),
  /** Run-all without opening a browser window. */
  headlessRunAll: z.boolean().default(true),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(800),
  timeoutSeconds: z.number().positive().default(10),
  retries: z.number().int().min(0).default(0),
  environment: Environment.default('TEST'),
  screenshotDir: z.string().default('screenshots'),
  runPlan: z.array(Stage).default([]),
});
export type Settings = z.infer<typeof Settings>;

export const FORMAT_VERSION = 1;

export const Project = z.object({
  formatVersion: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  name: z.string().min(1),
  settings: Settings.default({}),
  parameters: z.array(Parameter).default([]),
  tests: z.array(Test).default([]),
  keywords: z.array(Keyword).default([]),
  /** sha256 of each generated file at last save, to detect external edits. */
  generatedHashes: z.record(z.string()).default({}),
});
export type Project = z.infer<typeof Project>;
