/**
 * DSH 插件工具測試：以 apply() 做 list / call，覆蓋全部六個工具名稱與行為，
 * 並回歸驗證 execFile（不經 shell）對畸形／中繼字元輸入的處理。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const PLUGIN_PATH = path.join(REPO_ROOT, 'dsh-bundle', 'wuyong', 'index.js');
const SRC_PATH = path.join(REPO_ROOT, 'src');
const PROBE_PKG = path.join(TEST_DIR, 'fixtures', 'exec_probe_pkg');
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

const python = process.env.WUYONG_TEST_PYTHON
  || (spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf-8' }).status === 0
    ? 'python3'
    : 'python');

const {
  apply,
  listTools,
  callTool,
  runWuyong,
  validateWuyongInvocation,
  TOOL_ANNOTATIONS,
  TOOL_NAMES,
  processRunner,
} = await import(pathToFileURL(PLUGIN_PATH).href);

const EXPECTED_NAMES = [
  'wuyong.doctor',
  'wuyong.hint',
  'wuyong.pool.list',
  'wuyong.pool.sync',
  'wuyong.local.list',
  'wuyong.local.harvest',
];

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONPATH: SRC_PATH,
    PYTHONIOENCODING: 'utf-8',
    ...extra,
  };
}

function makeTempProject({ autoDetect = false, extraRoots = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wuyong-dsh-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'state'), { recursive: true });
  mkdirSync(path.join(root, 'skills', 'local-made'), { recursive: true });
  writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "wuyong-fixture"\nversion = "0.0.0"\n', 'utf8');
  const extraLiteral = extraRoots.map((p) => JSON.stringify(p)).join(', ');
  writeFileSync(path.join(root, 'config', 'wuyong.toml'), `# test fixture
[general]
mode = "advise"
log_redact = true

[signals]
user_weight = 1.0
thinking_weight = 1.2
intent_threshold = 0.30

[router]
local_min_score = 0.34
online_query_max_words = 8

[monitor]
min_installs = 1000000
interval_seconds = 21600
jitter_ratio = 0.10
hysteresis_rounds = 2
install_mode = "lazy"

[installer]
node_cmd = "npx"
timeout_seconds = 300

[local_roots]
extra = [${extraLiteral}]
auto_detect = ${autoDetect ? 'true' : 'false'}
`, 'utf8');
  return root;
}

function pluginConfig(projectRoot, overrides = {}) {
  return {
    python,
    projectRoot,
    dryRun: true,
    mode: 'advise',
    env: baseEnv({ WUYONG_ROOT: projectRoot }),
    ...overrides,
  };
}

function recordedExec() {
  const calls = [];
  const execFileSync = (file, args, opts) => {
    calls.push({ file, args: [...args], opts });
    return JSON.stringify({ ok: true, probe: true, argv: [file, ...args] });
  };
  return { calls, execFileSync };
}

describe('DSH tool annotations (MCP list)', () => {
  test('lists exactly the six tools by name with all four boolean hints', () => {
    const listed = listTools({});
    assert.deepEqual(listed.map((t) => t.name), EXPECTED_NAMES);
    assert.deepEqual([...TOOL_NAMES], EXPECTED_NAMES);
    assert.equal(listed.length, 6);

    for (const tool of listed) {
      const annotations = tool.annotations;
      assert.ok(annotations, `${tool.name} must expose annotations`);
      for (const hint of HINTS) {
        assert.equal(typeof annotations[hint], 'boolean', `${tool.name}.${hint} must be an explicit boolean`);
      }
      assert.deepEqual(annotations, TOOL_ANNOTATIONS[tool.name]);
    }
  });

  test('hint values match actual handler effects, not default MCP defaults', () => {
    const byName = Object.fromEntries(listTools({}).map((t) => [t.name, t.annotations]));

    assert.equal(byName['wuyong.doctor'].readOnlyHint, false);
    assert.equal(byName['wuyong.doctor'].destructiveHint, false);
    assert.equal(byName['wuyong.doctor'].idempotentHint, true);
    assert.equal(byName['wuyong.doctor'].openWorldHint, true);

    assert.equal(byName['wuyong.hint'].readOnlyHint, false);
    assert.equal(byName['wuyong.hint'].destructiveHint, false);
    assert.equal(byName['wuyong.hint'].idempotentHint, false);
    assert.equal(byName['wuyong.hint'].openWorldHint, true);

    assert.equal(byName['wuyong.pool.list'].readOnlyHint, true);
    assert.equal(byName['wuyong.pool.list'].openWorldHint, false);

    assert.equal(byName['wuyong.pool.sync'].readOnlyHint, false);
    assert.equal(byName['wuyong.pool.sync'].idempotentHint, false);
    assert.equal(byName['wuyong.pool.sync'].openWorldHint, true);

    assert.equal(byName['wuyong.local.list'].readOnlyHint, true);
    assert.equal(byName['wuyong.local.list'].openWorldHint, false);

    assert.equal(byName['wuyong.local.harvest'].readOnlyHint, false);
    assert.equal(byName['wuyong.local.harvest'].destructiveHint, false);
    assert.equal(byName['wuyong.local.harvest'].idempotentHint, true);
    assert.equal(byName['wuyong.local.harvest'].openWorldHint, false);
  });
});

describe('DSH tool call wiring (mocked execFile)', () => {
  test('wuyong.doctor invokes python -m wuyong doctor without a shell string', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.doctor', {}, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.equal(result.report.probe, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-m', 'wuyong', 'doctor']);
    assert.equal(calls[0].opts.encoding, 'utf-8');
    assert.equal(calls[0].opts.shell, undefined);
  });

  test('wuyong.hint passes text, thinking, mode and dry-run as discrete argv', async () => {
    const { calls, execFileSync } = recordedExec();
    const text = 'find a skill; rm -rf / && echo pwned';
    const thinking = 'maybe $(touch pwned) `id`';
    const result = await callTool('wuyong.hint', {
      text,
      thinking,
      conversationId: 't-hint',
      mode: 'advise',
      dryRun: true,
    }, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.ok(result.decision);
    assert.deepEqual(calls[0].args, [
      '-m', 'wuyong', 'hint',
      '--text', text,
      '--conversation', 't-hint',
      '--thinking', thinking,
      '--mode', 'advise',
      '--dry-run',
    ]);
  });

  test('wuyong.hint rejects non-string text before spawning', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.hint', { text: 42 }, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.error, 'text must be a string');
    assert.equal(result.exitCode, 2);
    assert.equal(calls.length, 0);
  });

  test('wuyong.pool.list invokes pool list', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.pool.list', { includeBelow: true }, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.ok(result.pool);
    assert.deepEqual(calls[0].args, ['-m', 'wuyong', 'pool', 'list']);
  });

  test('wuyong.pool.sync invokes pool sync and optional --check-hash', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.pool.sync', { checkHash: true }, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.ok(result.summary);
    assert.deepEqual(calls[0].args, ['-m', 'wuyong', 'pool', 'sync', '--check-hash']);
  });

  test('wuyong.local.list invokes local list', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.local.list', {}, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.ok(result.index);
    assert.deepEqual(calls[0].args, ['-m', 'wuyong', 'local', 'list']);
  });

  test('wuyong.local.harvest invokes local harvest', async () => {
    const { calls, execFileSync } = recordedExec();
    const result = await callTool('wuyong.local.harvest', { conversationId: 't-harvest' }, pluginConfig(REPO_ROOT, { execFileSync }));
    assert.equal(result.ok, true);
    assert.ok(result.registered);
    assert.deepEqual(calls[0].args, ['-m', 'wuyong', 'local', 'harvest']);
  });
});

describe('real CLI behaviour through tool handlers', () => {
  let projectRoot;
  let skillRoot;

  before(() => {
    skillRoot = mkdtempSync(path.join(tmpdir(), 'wuyong-skills-'));
    const skillDir = path.join(skillRoot, 'probe-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: probe-skill
description: Temporary skill used by DSH tool tests
tags: [probe, test]
---

# probe-skill
`, 'utf8');
    projectRoot = makeTempProject({ autoDetect: false, extraRoots: [skillRoot] });
  });

  after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(skillRoot, { recursive: true, force: true });
  });

  test('wuyong.doctor returns a parsed environment report', async () => {
    const result = await callTool('wuyong.doctor', {}, pluginConfig(projectRoot));
    assert.equal(result.ok, true);
    assert.ok(result.report);
    assert.equal(result.report.project, projectRoot);
    assert.equal(typeof result.report.python_ok, 'boolean');
    assert.equal(typeof result.report.state_writable, 'boolean');
    assert.equal(result.report.state_writable, true);
    assert.equal(existsSync(path.join(projectRoot, 'state', '.doctor_probe')), false);
  });

  test('wuyong.hint with low-intent text returns a Decision and does not draft', async () => {
    const result = await callTool('wuyong.hint', {
      text: 'hello',
      conversationId: 'dsh-test',
      dryRun: true,
    }, pluginConfig(projectRoot));
    assert.equal(result.ok, true);
    assert.ok(result.decision);
    assert.equal(typeof result.decision.intent_detected, 'boolean');
    assert.equal(result.decision.intent_detected, false);
    assert.equal(result.decision.route, 'none');
    const drafts = readdirSync(path.join(projectRoot, 'skills', 'local-made'));
    assert.equal(drafts.filter((name) => name.startsWith('draft-')).length, 0);
  });

  test('wuyong.pool.list returns the current pool payload', async () => {
    const result = await callTool('wuyong.pool.list', {}, pluginConfig(projectRoot));
    assert.equal(result.ok, true);
    assert.ok(result.pool);
    assert.ok(Array.isArray(result.pool.pool));
    assert.equal(typeof result.pool.count, 'number');
  });

  test('wuyong.local.list returns the local index payload', async () => {
    const result = await callTool('wuyong.local.list', {}, pluginConfig(projectRoot));
    assert.equal(result.ok, true);
    assert.ok(result.index);
    assert.ok(Array.isArray(result.index.index));
    assert.equal(typeof result.index.count, 'number');
  });

  test('wuyong.local.harvest registers a skill discovered under configured roots', async () => {
    const result = await callTool('wuyong.local.harvest', {}, pluginConfig(projectRoot));
    assert.equal(result.ok, true);
    assert.ok(result.registered);
    const names = (result.registered.registered || []).map((e) => e.name);
    assert.ok(names.includes('probe-skill'), `expected probe-skill, got ${JSON.stringify(result.registered)}`);
    const listed = await callTool('wuyong.local.list', {}, pluginConfig(projectRoot));
    const listedNames = (listed.index.index || []).map((e) => e.name);
    assert.ok(listedNames.includes('probe-skill'));
  });

  test('wuyong.pool.sync is callable and forwards CLI failure without crashing', async () => {
    // Avoid a live skills.sh sync in unit tests: stub exec to a failing child result
    // is covered by the wiring test. Here, confirm the handler surfaces a real CLI error
    // when python is pointed at a missing executable.
    const result = await callTool('wuyong.pool.sync', {}, pluginConfig(projectRoot, {
      python: path.join(projectRoot, 'no-such-python-binary'),
    }));
    assert.ok(result.error);
    assert.notEqual(result.exitCode, 0);
  });
});

describe('runWuyong validation and shell-injection regressions', () => {
  test('rejects malformed python, cwd and args before spawn', () => {
    assert.equal(validateWuyongInvocation(['doctor'], { python: '' }).ok, false);
    assert.equal(validateWuyongInvocation(['doctor'], { python: 1 }).ok, false);
    assert.equal(validateWuyongInvocation(['doctor'], { python: 'py\0thon' }).error.includes('NUL'), true);
    assert.equal(validateWuyongInvocation(['doctor'], { projectRoot: '' }).ok, false);
    assert.equal(validateWuyongInvocation(['doctor'], { projectRoot: 'dir\0' }).ok, false);
    assert.equal(validateWuyongInvocation('doctor', {}).ok, false);
    assert.equal(validateWuyongInvocation(['doctor', 1], {}).ok, false);
    assert.equal(validateWuyongInvocation(['ok\0bad'], {}).ok, false);
    assert.equal(validateWuyongInvocation(['doctor'], { python: 'python3', projectRoot: REPO_ROOT }).ok, true);
  });

  test('runWuyong returns a validation error for malformed input and does not spawn', () => {
    let spawned = false;
    const original = processRunner.execFileSync;
    processRunner.execFileSync = () => {
      spawned = true;
      return '{}';
    };
    try {
      const r = runWuyong(['hint', '--text', 9]);
      assert.equal(r.ok, false);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /must be a string/);
      assert.equal(spawned, false);
    } finally {
      processRunner.execFileSync = original;
    }
  });

  test('metacharacter text is passed literally and does not run through a shell', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'wuyong-shell-'));
    const marker = path.join(work, 'PWNED');
    const payload = `; touch ${marker} && echo pwned | tee ${marker} $(touch ${marker}) \`touch ${marker}\``;
    const env = baseEnv({
      PYTHONPATH: PROBE_PKG,
      WUYONG_ROOT: work,
    });
    const r = runWuyong(['hint', '--text', payload], {
      python,
      projectRoot: work,
      env,
    });
    assert.equal(r.ok, true, r.stderr);
    const parsed = JSON.parse(r.stdout);
    // python -m 會吃掉 -m wuyong，sys.argv 從模組路徑開始；重點是 payload 必須原樣出現且未經 shell。
    assert.equal(parsed.argv[1], 'hint');
    assert.equal(parsed.argv[2], '--text');
    assert.equal(parsed.argv[3], payload);
    assert.equal(existsSync(marker), false, 'shell metacharacters must not be executed');
    rmSync(work, { recursive: true, force: true });
  });

  test('python path and projectRoot with spaces stay intact under execFile', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'wuyong dir '));
    const env = baseEnv({
      PYTHONPATH: PROBE_PKG,
      WUYONG_ROOT: work,
    });
    const r = runWuyong(['doctor'], { python, projectRoot: work, env });
    assert.equal(r.ok, true, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.cwd, work);
    assert.equal(parsed.argv[1], 'doctor');
    rmSync(work, { recursive: true, force: true });
  });

  test('production plugin no longer shells out via execSync(string)', () => {
    const source = readFileSync(PLUGIN_PATH, 'utf8');
    assert.equal(source.includes('execSync'), false);
    assert.equal(source.includes("from 'node:child_process'"), true);
    assert.equal(source.includes('execFileSync'), true);
    assert.match(source, /windowsHide:\s*true/);
  });
});

describe('plugin apply() still exposes inject and Config', () => {
  test('registers six tools via ctx.effect and keeps public exports', () => {
    const registered = [];
    const cleanup = apply({
      effect(def) { registered.push(def); },
    }, {});
    assert.equal(typeof cleanup, 'function');
    assert.deepEqual(registered.map((t) => t.name), EXPECTED_NAMES);
    assert.ok(registered.every((t) => t.type === 'tool' && typeof t.handler === 'function'));
  });
});
