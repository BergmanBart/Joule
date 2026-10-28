import { describe, expect, it } from 'vitest';
import {
  arg,
  buildSelector,
  effectiveRunPlan,
  generateRobotFiles,
  moveSteps,
  newProject,
  numberSteps,
  pickSteps,
  Project,
  resolveParameters,
  suiteNameFromFile,
  unarg,
  type ElementDescriptor,
  type Step,
} from '../src';

const button: ElementDescriptor = {
  tag: 'button',
  id: 'login',
  classes: ['btn', 'primary'],
  attributes: { type: 'submit', 'data-testid': 'login-btn' },
  text: 'Log in',
  xpath: '/html/body/form/button',
  cssPath: 'form > button',
};
const input: ElementDescriptor = { tag: 'input', classes: [], attributes: { name: 'user', type: 'text' } };

function el(id: string, props: ElementDescriptor, rest: Partial<Extract<Step, { type: 'element' }>>): Step {
  return { id, name: '', type: 'element', mode: 'action', locator: { props, use: ['tag', 'attr:name'] }, ...rest } as Step;
}

function sampleProject(): Project {
  const p = newProject('Demo', 'https://example.com');
  p.parameters.push({ name: 'USERNAME', values: { default: 'alice', PROD: 'prod-user' } });
  p.keywords.push({
    id: 'kw1',
    name: 'Login',
    steps: [el('k1', input, { action: { kind: 'fill', value: '${USERNAME}' } })],
  });
  const t = p.tests[0];
  t.id = 't1';
  t.parameters.push({ name: 'USERNAME', values: { default: 'bob' } });
  t.steps = [
    { id: 'c1', name: '', type: 'keywordCall', keywordId: 'kw1' },
    {
      id: 'g1',
      name: 'Fill form',
      type: 'group',
      collapsed: false,
      steps: [
        el('s1', input, { action: { kind: 'fill', value: 'two  spaces' } }),
        { id: 's2', name: '', type: 'element', mode: 'action', locator: { props: button, use: ['tag', 'id'] }, action: { kind: 'dblclick' } },
      ],
    },
    {
      id: 'if1',
      name: '',
      type: 'if',
      condition: { locator: { props: button, use: ['attr:data-testid'] }, assertion: { property: 'text', operator: '==', expected: 'Log in' } },
      then: [
        {
          id: 'if2',
          name: '',
          type: 'if',
          condition: { locator: { props: button, use: ['tag'] }, assertion: { property: 'state', operator: '!=', expected: 'disabled' } },
          then: [{ id: 'w1', name: '', type: 'wait', wait: { kind: 'time', seconds: 2 } }],
          else: [],
        },
      ],
      else: [{ id: 'p1', name: '', type: 'pause' }],
    },
    { id: 'sh1', name: '', type: 'screenshot', filename: 'after-login', fullPage: true },
    {
      id: 'a1',
      name: '',
      type: 'element',
      mode: 'assert',
      locator: { props: button, use: ['tag', 'class:primary'] },
      assertion: { property: 'attribute', name: 'type', operator: 'contains', expected: '${EXPECTED_TYPE}' },
    },
  ];
  return Project.parse(p);
}

describe('selector', () => {
  it('combines css properties', () => {
    expect(buildSelector({ props: button, use: ['tag', 'id', 'class:btn', 'attr:type', 'text'] })).toBe(
      'css=button#login.btn[type="submit"]:text-is("Log in")',
    );
  });
  it('xpath and css path are exclusive', () => {
    expect(buildSelector({ props: button, use: ['tag', 'xpath'] })).toBe('xpath=/html/body/form/button');
    expect(buildSelector({ props: button, use: ['css', 'tag'] })).toBe('css=form > button');
  });
  it('custom selector wins', () => {
    expect(buildSelector({ props: button, use: ['tag'], custom: ' text=Hi ' })).toBe('text=Hi');
  });
});

describe('robot escaping', () => {
  it('round-trips awkward values', () => {
    for (const v of ['', 'a  b', ' lead', 'trail ', '#hash', 'text=foo', 'back\\slash', 'line\nbreak']) {
      expect(unarg(arg(v))).toBe(v);
    }
    expect(arg('${USERNAME}')).toBe('${USERNAME}');
    expect(arg('css=button')).toBe('css=button');
  });
  it('derives suite names like robot', () => {
    expect(suiteNameFromFile('login_flow')).toBe('Login Flow');
    expect(suiteNameFromFile('Login_Flow')).toBe('Login Flow');
    expect(suiteNameFromFile('myTest')).toBe('myTest');
  });
});

describe('parameters', () => {
  it('test overrides project and is flagged', () => {
    const p = sampleProject();
    const r = resolveParameters(p, p.tests[0], 'PROD');
    expect(r.find((x) => x.name === 'USERNAME')).toMatchObject({ value: 'bob', source: 'test', shadowed: true });
    expect(resolveParameters(p, undefined, 'PROD').find((x) => x.name === 'USERNAME')?.value).toBe('prod-user');
    expect(resolveParameters(p, undefined, 'DEV').find((x) => x.name === 'USERNAME')?.value).toBe('alice');
  });
});

describe('step tree', () => {
  it('numbers every non-group step', () => {
    const n = numberSteps(sampleProject().tests[0].steps);
    expect([...n.keys()]).toEqual(['c1', 's1', 's2', 'if1', 'if2', 'w1', 'p1', 'sh1', 'a1']);
  });
  it('picks selected steps; selected group keeps children', () => {
    const steps = sampleProject().tests[0].steps;
    expect(pickSteps(steps, new Set(['g1'])).map((s) => s.id)).toEqual(['g1']);
    expect(pickSteps(steps, new Set(['s2', 'sh1'])).map((s) => s.id)).toEqual(['s2', 'sh1']);
    const picked = pickSteps(steps, new Set(['p1']));
    expect(picked[0]).toMatchObject({ id: 'if1', then: [], else: [{ id: 'p1' }] });
  });
  it('moves steps into a group and refuses moving into itself', () => {
    const steps = sampleProject().tests[0].steps;
    const moved = moveSteps(steps, ['sh1'], 'g1', 0);
    expect(moved.map((s) => s.id)).toEqual(['c1', 'g1', 'if1', 'a1']);
    expect((moved[1] as Extract<Step, { type: 'group' }>).steps.map((s) => s.id)).toEqual(['sh1', 's1', 's2']);
    expect(moveSteps(steps, ['if1'], 'if2:then', 0)).toBe(steps);
    const down = moveSteps(steps, ['c1'], 'root', 3);
    expect(down.map((s) => s.id)).toEqual(['g1', 'if1', 'c1', 'sh1', 'a1']);
  });
});

describe('robot generation', () => {
  const files = generateRobotFiles(sampleProject());

  it('writes the expected files', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        'env/ACC.py', 'env/DEV.py', 'env/PROD.py', 'env/TEST.py', 'resources/UITesterLib.py', 'resources/keywords.resource',
        'resources/uitester.resource', 'run.bat', 'run.sh', 'run_parallel.bat', 'run_plan.txt', 'tests/Test1.robot',
      ].sort(),
    );
    expect(files['env/PROD.py']).toContain('USERNAME = "prod-user"');
    expect(files['env/DEV.py']).toContain('URL = "https://example.com"');
  });

  it('generates the test suite', () => {
    expect(files['tests/Test1.robot']).toMatchInlineSnapshot(`
      "*** Settings ***
      Documentation    Generated by UITester. Edit this test in UITester; manual changes are detected when the project is opened.
      Resource    ../resources/uitester.resource
      Resource    ../resources/keywords.resource
      Variables    ../env/\${ENV}.py
      Suite Setup    Open UITester Browser
      Suite Teardown    Close Browser    ALL

      *** Variables ***
      \${ENV}    TEST
      \${USERNAME}    bob

      *** Test Cases ***
      Test1
          [Documentation]    UITester test t1
          [Tags]    happy    regression
          Login
          Fill form
          \${condition_1}=    Run Keyword And Return Status    Get Text    css=[data-testid="login-btn"]    ==    Log in
          IF    \${condition_1}
              \${condition_2}=    Run Keyword And Return Status    Get Element States    css=button    not contains    disabled
              IF    \${condition_2}
                  Sleep    2s
              END
          ELSE
              Pause For Key
          END
          Take Screenshot    filename=\${SCREENSHOT_DIR}/after-login    fullPage=True
          Get Attribute    css=button.primary    type    contains    \${EXPECTED_TYPE}

      *** Keywords ***
      Fill form
          [Documentation]    UITester group g1
          Fill Text    css=input[name="user"]    two \${SPACE}spaces
          Click With Options    css=button#login    left    clickCount=2
      "
    `);
  });

  it('puts linked groups in keywords.resource', () => {
    expect(files['resources/keywords.resource']).toContain('Login\n    [Documentation]    UITester keyword kw1\n    Fill Text    css=input[name="user"]    ${USERNAME}');
  });

  it('renames groups that would shadow library keywords', () => {
    const p = sampleProject();
    p.tests[0].steps = [{ id: 'g', name: 'Click', type: 'group', collapsed: false, steps: [] }];
    const robot = generateRobotFiles(p)['tests/Test1.robot'];
    expect(robot).toContain('\n    Click Steps\n');
    expect(robot).toContain('\nClick Steps\n    [Documentation]    UITester group g\n    No Operation');
  });

  it('builds the pabot ordering from the run plan', () => {
    const p = sampleProject();
    p.tests.push({ ...p.tests[0], id: 't2', name: 'checkout flow' }, { ...p.tests[0], id: 't3', name: 'Search' });
    p.settings.runPlan = [{ tests: [p.tests[0].id, 't3'] }];
    expect(effectiveRunPlan(p)).toEqual([[p.tests[0].id, 't3'], ['t2']]);
    expect(generateRobotFiles(p)['run_plan.txt']).toBe('--suite Tests.Test1\n--suite Tests.Search\n#WAIT\n--suite Tests.Checkout Flow\n');
  });
});
