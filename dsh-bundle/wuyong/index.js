/**
 * 晏銘湛箴_無用之用 — DSH 插件入口
 *
 * 將 wuyong 的 CLI 能力註冊為 DSH 工具，讓主代理在對話中直接呼叫：
 *  - wuyong.doctor: 檢查環境與核心技能
 *  - wuyong.hint: 對單一事件輸出 Decision JSON
 *  - wuyong.pool.list / wuyong.pool.sync: 動態技能池
 *  - wuyong.local.list / wuyong.local.harvest: 本地技能索引
 *
 * 本檔即插件原始碼（無另外的產生器或打包步驟覆寫它）。
 * 工具註釋依 MCP ToolAnnotations，布林值對應 handler 的實際副作用。
 */

import { execFileSync } from 'node:child_process';

export const inject = ['tools'];

export const Config = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['observe', 'advise', 'act'], default: 'advise' },
    dryRun: { type: 'boolean', default: true },
    python: { type: 'string', default: 'python' },
    projectRoot: { type: 'string' },
  },
  additionalProperties: false,
};

/** 可在測試中替換；正式執行使用 node:child_process.execFileSync（不經過 shell）。 */
export const processRunner = {
  execFileSync,
};

/**
 * 各工具的 MCP annotations。四個 hint 皆為明確的 true/false。
 *
 * 語意（對應 MCP 2025-03-26 ToolAnnotations）：
 *  - readOnlyHint: 是否完全不修改環境
 *  - destructiveHint: 非唯讀時，是否可能做破壞性更新（false 表示只做附加／狀態更新）
 *  - idempotentHint: 非唯讀時，以相同參數重複呼叫是否不再產生額外環境效應
 *  - openWorldHint: 是否可能與外部世界互動（例如存取 skills.sh 或下載套件）
 */
export const TOOL_ANNOTATIONS = {
  'wuyong.doctor': {
    // 可能建立 state/、寫入後刪除 .doctor_probe；並對 https://skills.sh/ 發出網路請求。
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  'wuyong.hint': {
    // 預設 dry-run 仍可能在 route=none 時寫入帶時間戳的 SKILL.md 草稿（每次新檔）；
    // mode=act 且非 dry-run 時可能透過 npx 安裝技能（聯網）。
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  'wuyong.pool.list': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  'wuyong.pool.sync': {
    // 從 skills.sh 同步並寫入 pool.json / 快照 / events.jsonl；below_streak 會累加，故非冪等。
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  'wuyong.local.list': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  'wuyong.local.harvest': {
    // 掃描已設定的本地根目錄並附加寫入 local-index.json，不刪除既有條目。
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_ANNOTATIONS));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 驗證 python、工作目錄與即將傳給 execFile 的參數。
 * 不經過 shell，仍拒絕非字串與 NUL，避免畸形輸入進入子行程 argv。
 * @returns {{ ok: true, python: string, cwd: string, args: string[] } | { ok: false, error: string }}
 */
export function validateWuyongInvocation(args, opts = {}) {
  const python = opts.python === undefined || opts.python === null ? 'python' : opts.python;
  const cwd = opts.projectRoot === undefined || opts.projectRoot === null ? process.cwd() : opts.projectRoot;

  if (!isNonEmptyString(python)) {
    return { ok: false, error: 'python must be a non-empty string' };
  }
  if (python.includes('\0')) {
    return { ok: false, error: 'python must not contain a NUL byte' };
  }
  if (!isNonEmptyString(cwd)) {
    return { ok: false, error: 'projectRoot must be a non-empty string' };
  }
  if (cwd.includes('\0')) {
    return { ok: false, error: 'projectRoot must not contain a NUL byte' };
  }
  if (!Array.isArray(args)) {
    return { ok: false, error: 'args must be an array of strings' };
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      return { ok: false, error: `args[${i}] must be a string` };
    }
    if (arg.includes('\0')) {
      return { ok: false, error: `args[${i}] must not contain a NUL byte` };
    }
  }
  return { ok: true, python, cwd, args };
}

/**
 * 以 argv 陣列直接啟動 python -m wuyong，不使用 shell，避免參數被中繼字元解譯。
 */
export function runWuyong(args, opts = {}) {
  const checked = validateWuyongInvocation(args, opts);
  if (!checked.ok) {
    return { ok: false, stderr: checked.error, exitCode: 2 };
  }
  const execFile = opts.execFileSync || processRunner.execFileSync;
  const execOpts = {
    cwd: checked.cwd,
    encoding: 'utf-8',
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  };
  if (opts.env) {
    execOpts.env = opts.env;
  }
  try {
    const out = execFile(checked.python, ['-m', 'wuyong', ...checked.args], execOpts);
    return { ok: true, stdout: String(out).trim() };
  } catch (err) {
    return {
      ok: false,
      stderr: err.stderr ? err.stderr.toString().trim() : String(err),
      exitCode: err.status,
    };
  }
}

function parseJsonResult(stdout, key) {
  try {
    return { ok: true, [key]: JSON.parse(stdout) };
  } catch (_) {
    return { ok: true, raw: stdout };
  }
}

/** 以 MCP tools/list 形狀回傳已註冊工具（含 annotations），供宿主與測試檢查。 */
export function listTools(config = {}) {
  return collectTools(config).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { ...tool.annotations },
  }));
}

function collectTools(config = {}) {
  const tools = [];
  apply({
    effect(def) {
      if (def && def.type === 'tool') {
        tools.push(def);
      }
    },
  }, config);
  return tools;
}

/** 以 MCP tools/call 形狀呼叫已註冊 handler。 */
export async function callTool(name, args = {}, config = {}) {
  const tools = collectTools(config);
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  return tool.handler(args);
}

export function apply(ctx, config) {
  const mode = config && config.mode ? config.mode : 'advise';
  const dryRun = config && config.dryRun !== undefined ? config.dryRun : true;
  const python = config && config.python ? config.python : 'python';
  const projectRoot = config && config.projectRoot ? config.projectRoot : process.cwd();
  const env = config && config.env ? config.env : undefined;
  const execFileSyncImpl = config && config.execFileSync ? config.execFileSync : undefined;

  const baseOpts = { python, projectRoot, mode, dryRun };
  if (env) baseOpts.env = env;
  if (execFileSyncImpl) baseOpts.execFileSync = execFileSyncImpl;

  ctx.effect({
    type: 'tool',
    name: 'wuyong.doctor',
    title: 'Wuyong Doctor',
    description: 'Check Python / Node / npx / network / directory permissions / core skill status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.doctor'] },
    handler: async () => {
      const r = runWuyong(['doctor'], baseOpts);
      if (!r.ok) {
        return { error: r.stderr, exitCode: r.exitCode };
      }
      return parseJsonResult(r.stdout, 'report');
    },
  });

  ctx.effect({
    type: 'tool',
    name: 'wuyong.hint',
    title: 'Wuyong Hint',
    description: 'Decide a single user/thinking event and output a Decision JSON (local → pool → online → none).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'User input text' },
        thinking: { type: 'string', description: 'Model reasoning trace (optional)' },
        conversationId: { type: 'string', default: 'dsh' },
        mode: { type: 'string', enum: ['observe', 'advise', 'act'] },
        dryRun: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.hint'] },
    handler: async ({ text, thinking, conversationId = 'dsh', mode, dryRun }) => {
      if (typeof text !== 'string') {
        return { error: 'text must be a string', exitCode: 2 };
      }
      if (thinking !== undefined && typeof thinking !== 'string') {
        return { error: 'thinking must be a string', exitCode: 2 };
      }
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return { error: 'conversationId must be a non-empty string', exitCode: 2 };
      }
      const args = ['hint', '--text', text, '--conversation', conversationId];
      if (thinking) args.push('--thinking', thinking);
      if (mode) args.push('--mode', mode);
      if (dryRun !== undefined) {
        args.push(dryRun ? '--dry-run' : '--no-dry-run');
      } else if (baseOpts.dryRun) {
        args.push('--dry-run');
      }
      const r = runWuyong(args, baseOpts);
      if (!r.ok) {
        return { error: r.stderr, exitCode: r.exitCode };
      }
      return parseJsonResult(r.stdout, 'decision');
    },
  });

  ctx.effect({
    type: 'tool',
    name: 'wuyong.pool.list',
    title: 'Wuyong Pool List',
    description: 'List skills in the dynamic pool.',
    inputSchema: {
      type: 'object',
      properties: { includeBelow: { type: 'boolean', default: true } },
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.pool.list'] },
    handler: async ({ includeBelow = true } = {}) => {
      const args = ['pool', 'list'];
      if (!includeBelow) args.push('--include-below', 'false');
      const r = runWuyong(args, baseOpts);
      if (!r.ok) return { error: r.stderr, exitCode: r.exitCode };
      return parseJsonResult(r.stdout, 'pool');
    },
  });

  ctx.effect({
    type: 'tool',
    name: 'wuyong.pool.sync',
    title: 'Wuyong Pool Sync',
    description: 'Sync the dynamic pool from skills.sh (API → HTML → snapshot).',
    inputSchema: {
      type: 'object',
      properties: { checkHash: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.pool.sync'] },
    handler: async ({ checkHash = false } = {}) => {
      const args = ['pool', 'sync'];
      if (checkHash) args.push('--check-hash');
      const r = runWuyong(args, baseOpts);
      if (!r.ok) return { error: r.stderr, exitCode: r.exitCode };
      return parseJsonResult(r.stdout, 'summary');
    },
  });

  ctx.effect({
    type: 'tool',
    name: 'wuyong.local.list',
    title: 'Wuyong Local List',
    description: 'List locally registered skills (cross-conversation index).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.local.list'] },
    handler: async () => {
      const r = runWuyong(['local', 'list'], baseOpts);
      if (!r.ok) return { error: r.stderr, exitCode: r.exitCode };
      return parseJsonResult(r.stdout, 'index');
    },
  });

  ctx.effect({
    type: 'tool',
    name: 'wuyong.local.harvest',
    title: 'Wuyong Local Harvest',
    description: 'Scan configured local skill roots and register discovered skills.',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'string', default: 'dsh-harvest' } },
      additionalProperties: false,
    },
    annotations: { ...TOOL_ANNOTATIONS['wuyong.local.harvest'] },
    handler: async ({ conversationId = 'dsh-harvest' } = {}) => {
      void conversationId;
      const r = runWuyong(['local', 'harvest'], { ...baseOpts });
      if (!r.ok) return { error: r.stderr, exitCode: r.exitCode };
      return parseJsonResult(r.stdout, 'registered');
    },
  });

  return () => {
    // cleanup: nothing persistent to close
  };
}
