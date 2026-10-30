/**
 * dsh-island-bridge — 宿主半边。
 *
 * 职责：
 *   1. 以 answerer 身份加入 DSH 的两条审批瀑布（prepend + global），把待交互
 *      注册进注册表，并等待本机灵动岛面板的裁决；
 *   2. 采集会话状态（agents / sessions / sessionProjections / sessionQuery），
 *      组装全量快照，推送给 Swift 灵动岛面板（stdin JSON 行）；
 *   3. 面板回传的 decision → 注册表 settle → ctx.approval 链收到 DSH 动词。
 *
 * 全部通信经 stdio 与回环，无网络、无云端、无遥测。
 */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';
import { createHelperHost } from './helper-host.js';
import { createNavigation } from './navigation.js';

export const name = 'island-bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = path.join(__dirname, '..', 'helper', 'island-helper.swift');
const STATE_DIR = path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh'), 'dsh-island-bridge');
const BINARY = path.join(STATE_DIR, 'island-helper');
const HASH_FILE = BINARY + '.sha256';
const COMPILE_TIMEOUT_MS = 120_000;
const PUSH_DEBOUNCE_MS = 150;
const SAFETY_POLL_MS = 5000;
const MAX_FRAME_BYTES = 1_500_000;

/**
 * 诊断日志：默认关闭。设置 DSH_ISLAND_DEBUG=1 后写入
 * <DSH_HOME>/dsh-island-bridge/bridge-debug.log，不落仓库目录。
 */
const DEBUG = process.env.DSH_ISLAND_DEBUG === '1';
const DEBUG_LOG = path.join(STATE_DIR, 'bridge-debug.log');
function dbgLog(tag, obj) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString().slice(11, 23) + ' ' + tag + ' ' + JSON.stringify(obj).slice(0, 1500) + '\n');
  } catch (e) {}
}

const log = (...a) => console.log('[island-bridge]', ...a);

export function inject() { return ['approval', 'sessionQuery', 'sessions', 'agents', 'sessionProjections']; }

let registry = null;
let navigation = null;
let helperHost = null;
let helperReady = false;
let pushTimer = null;
let pushRevision = 0;
let lastPushAt = 0;
let lastPushJson = '';
let disposed = false;

export async function apply(ctx) {
  disposed = false;
  setBridgeContext(ctx);
  navigation = createNavigation({ onResult: result => dbgLog('navigation-result', result), onConnected: () => dbgLog('navigation-client', { ready: true }) });
  ctx.inject(['connection'], navCtx => {
    for (const route of navigation.routes) navCtx.connection.fetch.register(route);
  });
  registry = createRegistry({ onDismissed: () => schedulePush() });
  const unsubs = [];

  // ① 审批瀑布 answerer（prepend + global：必须先于 Web 远端应答器，且必须全局才收得到 agent 域分发）
  unsubs.push(ctx.effect(() => ctx.on('approval/request', async (req, next) => {
    try {
      dbgLog('approval-req', { keys: Object.keys(req ?? {}), toolName: req?.toolName, kind: req?.kind, sessionId: req?.agent?.session?.header?.id, agentId: req?.agent?.id });
    const sessionId = req?.agent?.session?.header?.id ?? '';
    const handle = registry.ask({
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      toolName: typeof req?.toolName === 'string' ? req.toolName : '',
      reason: typeof req?.reason === 'string' ? req.reason : undefined,
      displayReason: typeof req?.displayReason === 'string' ? req.displayReason : undefined,
      callId: typeof req?.callId === 'string' ? req.callId : undefined,
      signal: req?.signal
    });
    schedulePush();
    return arbitrate(handle, next);
    } catch (error) { console.error('[island-bridge] approval answerer error:', String(error)); return next(); }
  }, { prepend: true, global: true }), 'island-bridge: approval answerer'));

  // ② 提问瀑布（ask_user_question）
  unsubs.push(ctx.effect(() => ctx.on('user-questions/request', async (request, next) => {
    const owner = registry;
    let handle;
    try {
      const sessionId = request?.agent?.session?.header?.id ?? '';
      handle = owner.askUser({
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        questions: Array.isArray(request?.questions) ? request.questions : [],
        signal: request?.signal
      });
      schedulePush();
    } catch (error) {
      console.error('[island-bridge] question mirror error:', String(error));
      return next();
    }
    // The island only links to DSH for questions. Keep the original answer/error
    // and cancellation semantics; never race the UI against an empty answer.
    try {
      return await next();
    } finally {
      owner.dismiss(handle.requestId);
    }
  }, { prepend: true, global: true }), 'island-bridge: question answerer'));

  // ③ 会话事件 → 状态推送（事件驱动 + 5s 安全兜底轮询）
  unsubs.push(ctx.effect(() => ctx.on('session/event', () => schedulePush()), 'island-bridge: session events'));
  const poll = setInterval(() => { if (!disposed) schedulePush(); }, SAFETY_POLL_MS);
  if (typeof poll.unref === 'function') poll.unref();

  unsubs.push(ctx.effect(() => () => {
    disposed = true;
    clearInterval(poll);
    registry.clear();
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = null;
    navigation?.stop();
    helperHost?.stop();
  }), 'island-bridge: shutdown');

  // ④ 拉起面板（构建失败不影响宿主：审批继续由 DSH 本地 UI 应答）
  try {
    await ensureHelperBinary();
  } catch (error) {
    console.error('[island-bridge] 无法构建原生面板：', String(error?.message ?? error));
    console.error('[island-bridge] 需要 macOS + Xcode Command Line Tools（swiftc）。面板未启动，审批仍在 DSH 本地 UI 正常出现。');
    return;
  }
  if (disposed) return;
  helperHost = createHelperHost({
    spawnChild: () => spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } }),
    onStart: child => { dbgLog('helper-start', { pid: child.pid, version: 'v8-interaction-lifecycle' }); lastPushJson = ''; helperReady = false; schedulePush(); },
    onLine: handleHelperLine,
    onError: error => console.error('[island-bridge] helper:', String(error)),
    onStderr: chunk => { if (chunk.trim()) console.warn('[island-helper]', chunk.trim().slice(0, 300)); },
  });
  helperHost.start();
}

function arbitrate(handle, next) {
  const downstream = new AbortController();
  const upstream = handle.request?.signal;
  let request = handle.request;
  try {
    if (upstream !== undefined) {
      request.signal = AbortSignal.any([upstream, downstream.signal]);
    } else {
      request.signal = downstream.signal;
    }
  } catch (e) { /* 不可注入信号时退化为不可取消分支 */ }

  const island = Promise.resolve(handle.answered).then(
    (outcome) => ({ via: 'island', outcome }),
    () => ({ via: 'island-cancelled' })
  );
  const local = Promise.resolve().then(next).then(
    (value) => ({ via: 'local', value }),
    (error) => ({ via: 'local-error', error })
  );

  return Promise.race([island, local]).then(async (first) => {
    if (first.via === 'island') {
      try { downstream.abort(); } catch (e) {}
      void local.then(() => undefined, () => undefined);
      return first.outcome;
    }
    if (first.via === 'local') {
      // Local outcomes also include cancelled/unavailable. Removing the mirror
      // must not depend on whether the result is an island decision verb.
      registry.dismiss(handle.requestId);
      return first.value;
    }
    registry.dismiss(handle.requestId);
    throw first.error;
  });
}

async function ensureHelperBinary() {
  try {
    if (fs.readFileSync(HASH_FILE, 'utf8').trim() === sourceHash()) return;
  } catch (e) {}
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });
  // 先编到临时文件再原子重命名：旧 helper 正在运行（或路径只读挂载）时也能顺利升级
  const staging = `${BINARY}.building-${process.pid}`;
  try {
    await new Promise((resolve, reject) => {
      const child = execFile('swiftc', ['-O', '-o', staging, HELPER_SOURCE], { timeout: COMPILE_TIMEOUT_MS }, (err) => {
        if (err) {
          reject(err.code === 'ENOENT' ? new Error('找不到 swiftc，请安装 Xcode Command Line Tools（xcode-select --install）') : err);
        } else resolve();
      });
      child.on('error', reject);
    });
    fs.renameSync(staging, BINARY);
  } finally {
    try { fs.unlinkSync(staging); } catch (e) {}
  }
  fs.writeFileSync(HASH_FILE, sourceHash() + '\n');
  console.log('[island-bridge] helper compiled →', BINARY);
}

function sourceHash() {
  return createHash('sha256').update(fs.readFileSync(HELPER_SOURCE)).digest('hex').slice(0, 32);
}

function wakeDshWindow() {
  try {
    execFile('osascript', ['-e', 'tell application "DeepSeek Harness" to activate'], { timeout: 5000 }, () => {});
  } catch (e) {}
}

function handleHelperLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type === 'open') {
    if (!navigation?.publish(msg.sessionId)) return;
    wakeDshWindow();
    return;
  }
  if (msg.type === 'ready') { helperReady = true; schedulePush(); return; }
  if (msg.type === 'decision') {
    if (msg.kind === QUESTION_KIND) {
      const r = registry.settleDecision(msg.requestId, { kind: 'ask_user_question', answers: msg.answers });
      if (r.accepted) schedulePush();
      return;
    }
    const r = registry.settleOutcome(msg.requestId, msg.outcome);
    if (r.accepted) schedulePush();
  }
}

const QUESTION_KIND = 'ask_user_question';

function schedulePush() {
  if (disposed || pushTimer !== null) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!disposed) void pushState();
  }, PUSH_DEBOUNCE_MS);
  pushTimer.unref?.();
}

const prevRunning = new Map();   // sessionId -> 上一次的 title（用于完成边沿检测）
const completedFlash = [];       // 待推送的完成事件（一次）
async function pushState() {
  lastPushAt = Date.now();
  const target = helperHost?.child;
  if (!target) return;
  const revision = ++pushRevision;
  let sessions = [];
    try { sessions = collectSessionsBase(bridgeCtx); } catch (error) {
    console.error('[island-bridge] collect failed:', String(error));
    return;
  }
  // 完成边沿：上一轮 running、这一轮不在 → 视为完成，附带标题
  const nowIds = new Set(sessions.map(x => x.id));
  const completed = [];
  for (const [id, info] of prevRunning) {
    if (!nowIds.has(id)) { completed.push({ id, title: info.title }); prevRunning.delete(id); }
  }
  for (const row of sessions) prevRunning.set(row.id, { title: row.title });
  // 标题异步补全：查询后如有变化再补推一次（不阻塞审批上岛）
  void (async () => {
    try {
      const before = JSON.stringify(sessions.map(x => x.title));
      await enrichTitles(bridgeCtx, sessions);
      if (disposed || revision !== pushRevision || helperHost?.child !== target) return;
      for (const row of sessions) prevRunning.set(row.id, { title: row.title });
      const after = JSON.stringify(sessions.map(x => x.title));
      if (before === after) return;
      const payload2 = { type: 'update', sessions, completed: [] };
      const json2 = JSON.stringify(payload2);
      if (json2 !== lastPushJson && helperHost.send(json2)) lastPushJson = json2;
    } catch (e) {}
  })();
  const payload = { type: 'update', sessions, completed };
  dbgLog('push', { sessions: sessions.map(x => ({ id: x.id, title: x.title, hasPending: !!x.pending, kind: x.pending?.kind })), completed, registrySize: registry.size(), registrySessionIds: [...(function*(){ try { for (const e of registry.list(undefined)) yield { pend: e.request.sessionId, kind: e.request.kind }; } catch (e) {} })()] });
  const json = JSON.stringify(payload);
  if (json === lastPushJson) return;
  if (json.length > MAX_FRAME) { console.error('[island-bridge] frame too large, dropped'); return; }
  if (helperHost.send(json)) lastPushJson = json;
}

const MAX_FRAME = 1_400_000;

function collectSessions() { return collectSessionsWith(bridgeCtx); }

let bridgeCtx = null;
export function setBridgeContext(c) { bridgeCtx = c; }

// 同步快速采集：会话行 + 待交互附加 + 缓存标题（审批 pending 零延迟上岛）
function collectSessionsBase(ctx) {
  if (typeof ctx?.get !== 'function') return [];
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const projections = ctx.get('sessionProjections');
  if (typeof agents?.list !== 'function' || typeof agents?.get !== 'function'
    || typeof sessions?.get !== 'function' || typeof projections?.snapshot !== 'function') return [];
  const result = [];
  for (const agent of agents.list()) {
    if (agent?.status !== 'running') continue;
    const id = agent.id;
    if (agents.get(id) !== agent) continue;
    const session = sessions.get(id);
    if (!session || agent.session !== session) continue;
    const header = session.header;
    if (!header || header.id !== id || header.origin === 'subagent' || header.parentSession != null) continue;
    const snapshot = projections.snapshot(session, ['sessionListMetadata']);
    const metadata = snapshot.values.sessionListMetadata;
    if ((metadata?.blank ?? session.seq === 0) === true) continue;
    if (agents.get(id) !== agent || agent.status !== 'running') continue;
    const row = { id, cwd: typeof header.cwd === 'string' ? header.cwd : '', running: true, pending: null, title: '' };
    // 待交互附加（同步）：审批卡零延迟上岛
    for (const entry of registry.list(row.id)) {
      const req = entry.request || {};
      row.pending = {
        requestId: req.requestId,
        kind: req.kind,
        toolName: req.toolName || '',
        reason: req.reason || '',
        displayReason: req.displayReason || '',
        questions: Array.isArray(req.questions) ? req.questions : []
      };
      break;
    }
    // 标题先用缓存：审批卡立即有名字
    if (prevRunning.has(row.id)) row.title = prevRunning.get(row.id).title || '';
    result.push(row);
  }
  return result;
}

// 异步标题补全：查询后原地更新，返回标题是否有变化
async function enrichTitles(ctx, rows) {
  try {
    const ids = rows.map(r => r.id);
    if (typeof ctx.get('sessionQuery')?.readTitleSnapshots !== 'function' || ids.length === 0) return false;
    const results = await ctx.get('sessionQuery').readTitleSnapshots(ids);
    const map = new Map();
    // 陷阱（cindy-host 同款）：文本在 value.title.title 两层之下
    for (const row of (Array.isArray(results) ? results : [])) {
      if (row === null || typeof row !== 'object' || row.status !== 'fulfilled') continue;
      const text = row.value?.title?.title;
      if (typeof row.sessionId === 'string' && typeof text === 'string' && text.trim() !== '') {
        map.set(row.sessionId, text);
      }
    }
    let changed = false;
    for (const row of rows) {
      const t = map.get(row.id);
      if (t !== undefined && row.title !== t) { row.title = t; changed = true; }
    }
    return changed;
  } catch (e) { return false; }
}
