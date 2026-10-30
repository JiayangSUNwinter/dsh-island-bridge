/**
 * 待交互注册表（适配自 cindy-host 的 createApprovalRegistry 模式）。
 *
 * 两条瀑布在此注册：
 *   - approval/request   → kind 'permission'，裁决动词 'allowed-once' | 'rejected'
 *   - user-questions/request → kind 'ask_user_question'，按问题文本回 selected
 *
 * 无手机端、无云端：唯一的"控制器"是本机的灵动岛面板。
 */

export const PERMISSION_KIND = 'permission';
export const QUESTION_KIND = 'ask_user_question';

export function decisionOutcome(decision) {
  if (decision === null || typeof decision !== 'object') return null;
  const outcome = typeof decision.outcome === 'string' ? decision.outcome : null;
  if (outcome === 'allowed-once' || outcome === 'rejected') return outcome;
  return null;
}

export function questionAnswerOf(questions, decision) {
  if (decision?.kind !== undefined && decision.kind !== QUESTION_KIND) return null;
  const given = decision?.answers;
  if (given === null || typeof given !== 'object') return { answers: [] };
  const answers = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const raw = given[question?.question];
    const chosen = typeof raw === 'string' && raw !== '' ? [raw] : [];
    answers.push({
      id: String(question?.id ?? ''),
      selected: chosen,
      ...(chosen.filter((x) => !String(question?.question).includes(x) && x !== '').length === 0 ? {} : { custom: chosen.filter((l) => l !== '').join(', ') })
    });
  }
  return { answers };
}

export function createRegistry({ now = () => new Date(), onDismissed } = {}) {
  const pending = new Map();
  let counter = 0;

  function register({ sessionId, request, prefix, signal, answerOf }) {
    let settle;
    const answered = new Promise((resolve) => { settle = resolve; });
    const finish = (outcome) => {
      const entry = pending.get(request.requestId);
      if (entry === undefined) return;
      pending.delete(request.requestId);
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.onAbort !== null && signal !== undefined) signal.removeEventListener('abort', entry.onAbort);
      if (typeof onDismissed === 'function') {
        try { onDismissed({ sessionId, requestId: request.requestId }); } catch {}
      }
      settle(outcome);
    };
    const onAbort = signal === undefined ? null : () => finish(answerOf.cancelled);
    if (onAbort !== null) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(answerOf.cancelled), 600_000);
    if (typeof timer?.unref === 'function') timer.unref();
    pending.set(request.requestId, { sessionId, request, settle: finish, timer, onAbort, answerOf, createdAt: now().toISOString() });
    return { requestId: request.requestId, request, answered };
  }

  function ask({ sessionId, toolName, reason, displayReason, callId, signal }) {
    const requestId = 'island-approval-' + (++counter);
    const request = {
      kind: PERMISSION_KIND,
      requestId,
      sessionId,
      toolName: typeof toolName === 'string' ? toolName : '',
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      ...(typeof displayReason === 'string' && displayReason !== '' ? { displayReason } : {}),
      ...(typeof callId === 'string' ? { callId } : {}),
      createdAt: now().toISOString()
    };
    return register({ sessionId, request, signal, answerOf: { cancelled: 'cancelled', from: (d) => decisionOutcome(d) } });
  }

  function askUser({ sessionId, questions, signal }) {
    const items = Array.isArray(questions) ? questions : [];
    const requestId = 'island-question-' + (++counter);
    const request = {
      kind: QUESTION_KIND,
      requestId,
      sessionId,
      questions: items.map((q) => ({ ...q })),
      createdAt: now().toISOString()
    };
    const cancelled = { answers: items.map((q) => ({ id: String(q?.id ?? ''), selected: [] })) };
    return register({
      sessionId, request, signal,
      answerOf: { cancelled, from: (d) => questionAnswerOf(items, d) }
    });
  }

  function list(sessionId) {
    const rows = [];
    for (const entry of pending.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      rows.push({ request: { ...entry.request }, createdAt: entry.createdAt });
    }
    return rows;
  }

  function settleOutcome(requestId, outcome) {
    const entry = pending.get(requestId);
    if (entry === undefined) return { accepted: false };
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return { accepted: false };
    entry.settle(outcome);
    return { accepted: true };
  }

  function settleDecision(requestId, decision) {
    const entry = pending.get(requestId);
    if (entry === undefined) return { accepted: false };
    const outcome = entry.answerOf.from(decision);
    if (outcome === null) return { accepted: false };
    entry.settle(outcome);
    return { accepted: true };
  }

  function clear() {
    for (const requestId of [...pending.keys()]) {
      pending.get(requestId).settle(pending.get(requestId).answerOf.cancelled);
    }
  }

  return { ask, askUser, list, settleOutcome, settleDecision, clear, size: () => pending.size };
}
