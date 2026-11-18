import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_CONTINUE_RETRY = Object.freeze({
  autoRetry: true,
  retryMax: 3,
  // [dsh-purge] 二轮立刻发被拒根因之一:idle 后 280ms 自动续跑与用户 submit 竞态。
  // 关自动续跑,只保留 autoRetry(request-error 自动重试)。
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
});

const PERMANENT_CODES = new Set([
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID",
  "INVALID_REQUEST",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "BILLING",
  "MODEL_NOT_FOUND",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
]);

/** Official already retried these; a new "继续" turn cannot clear them. */
const NO_CONTINUE_CODES = new Set([
  ...PERMANENT_CODES,
  "RATE_LIMIT",
  "TRANSPORT",
]);

const ABNORMAL_KINDS = new Set(["error", "aborted", "interrupted", "max-tokens"]);

export function clampCount(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const retryMax = clampCount(src.retryMax, DEFAULT_CONTINUE_RETRY.retryMax);
  const continueMax = clampCount(src.continueMax, DEFAULT_CONTINUE_RETRY.continueMax);
  const text = typeof src.continueText === "string" ? src.continueText.trim() : "";
  return {
    autoRetry: src.autoRetry !== false && retryMax > 0,
    retryMax,
    autoContinue: src.autoContinue === true && continueMax > 0,
    continueMax,
    continueText: text || DEFAULT_CONTINUE_RETRY.continueText,
  };
}

export function settingsPath(dshHome) {
  return path.join(dshHome, "dsh-purge", "continue-retry.json");
}

export function loadSettings(dshHome) {
  const fp = settingsPath(dshHome);
  try {
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function mergeConfig(pluginCfg, saved) {
  const merged = { ...DEFAULT_CONTINUE_RETRY, ...pluginCfg, ...saved };
  // [dsh-purge] 默认仍然关自动续跑（DEFAULT 里就是 false，避免 idle 后 280ms 自动发车
  // 与用户 submit 竞态）。但用户在设置页里显式勾上时必须生效——否则那个开关是个谎，
  // 保存完读回来永远是 false。
  if (saved?.autoContinue !== true && pluginCfg?.autoContinue !== true) {
    merged.autoContinue = false;
  }
  return normalizeConfig(merged);
}

/** 落盘 continue-retry.json（原子写：同目录 tmp + rename，避免半截文件）。 */
export function saveSettings(dshHome, raw) {
  const settings = normalizeConfig(raw);
  const fp = settingsPath(dshHome || "");
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, fp);
    return { ok: true, settings };
  } catch (e) {
    try { if (fs.existsSync(fp + "." + process.pid + ".tmp")) fs.unlinkSync(fp + "." + process.pid + ".tmp"); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e), settings };
  }
}

export function lastTurnEnd(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type === "turn/end") return event;
  }
  return null;
}

export function isUserAbort(reason) {
  if (!reason || reason.kind !== "aborted") return false;
  const cause = reason.reason;
  if (cause === "user" || cause === "cancel") return true;
  if (cause && typeof cause === "object") {
    return cause.kind === "user" || cause.kind === "cancel";
  }
  return false;
}

export function isAbnormalReason(reason) {
  return Boolean(reason && ABNORMAL_KINDS.has(reason.kind));
}

export function failureCodeOf(reason) {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code;
  return String(raw || "").toUpperCase();
}

export function shouldAutoContinue(reason) {
  if (!isAbnormalReason(reason) || isUserAbort(reason)) return false;
  const code = failureCodeOf(reason);
  return !code || !NO_CONTINUE_CODES.has(code);
}

export function isPermanentFailure(code) {
  return PERMANENT_CODES.has(String(code || "").toUpperCase());
}

export function shouldAutoRetry(failure, signal) {
  if (signal?.aborted) return false;
  return !isPermanentFailure(failure?.code);
}

export function makeContinueMessage(text) {
  const body = String(text || DEFAULT_CONTINUE_RETRY.continueText).trim() || DEFAULT_CONTINUE_RETRY.continueText;
  return {
    id: `dsh-purge-continue-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: {
      kind: "dsh-purge",
      form: "notice",
      summary: "continue",
    },
  };
}

// cordis 没有 session/removed 事件可挂,长开进程 session 一直累积。
// 用 Map 插入顺序做 FIFO 兜底:超过 CAP 就丢最早的一批。
const TRACKER_SESSION_CAP = 200;
const TRACKER_SESSION_EVICT = 50;

export function createTracker() {
  const bySession = new Map();

  function slot(sessionId) {
    const id = String(sessionId || "");
    if (!id) return null;
    let cur = bySession.get(id);
    if (!cur) {
      if (bySession.size >= TRACKER_SESSION_CAP) {
        let i = 0;
        for (const k of bySession.keys()) {
          if (i >= TRACKER_SESSION_EVICT) break;
          bySession.delete(k);
          i += 1;
        }
      }
      cur = { retry: 0, continue: 0, lastContinueSeq: 0, lastRetryKey: "" };
      bySession.set(id, cur);
    }
    return cur;
  }

  return {
    takeRetry(sessionId, key, max) {
      const cur = slot(sessionId);
      if (!cur || max <= 0) return false;
      if (key && cur.lastRetryKey === key) return false;
      if (cur.retry >= max) return false;
      cur.retry += 1;
      cur.lastRetryKey = key || "";
      return true;
    },
    takeContinue(sessionId, seq, max, maxFailStreak = 3) {
      const cur = slot(sessionId);
      if (!cur || max <= 0) return false;
      if (seq && cur.lastContinueSeq === seq) return false;
      if (cur.continue >= max) return false;
      if ((cur.failStreak || 0) >= maxFailStreak) return false;
      cur.continue += 1;
      cur.lastContinueSeq = seq || 0;
      return true;
    },
    refundContinue(sessionId, seq) {
      const cur = slot(sessionId);
      if (!cur || cur.continue <= 0) return;
      cur.continue -= 1;
      // 关键:不清 lastContinueSeq —— 同一 seq 的失败不再重复消耗 continue 预算
      // 关键:记录连续失败次数,达到 maxFailStreak 永久停手(Issue #85)
      cur.failStreak = (cur.failStreak || 0) + 1;
      if (seq) {
        cur.failedSeqs = cur.failedSeqs || new Set();
        // cap:长会话 failedSeqs 永不清(resetIfCompleted 只在 completed/blocked 时清),
        // 失败 seq 累积几千几万 → Set 内存涨。cap 256,超了删最老的(Set 保持 insertion order)。
        if (cur.failedSeqs.size >= 256) {
          const oldest = cur.failedSeqs.values().next().value;
          if (oldest !== undefined) cur.failedSeqs.delete(oldest);
        }
        cur.failedSeqs.add(seq);
      }
    },
    /** 只读计数，不创建 slot —— HTTP 轮询每 1200ms 打一次，不能顺手把 Map 撑起来。 */
    peek(sessionId) {
      const cur = bySession.get(String(sessionId || ""));
      if (!cur) return { retry: 0, continue: 0, failStreak: 0 };
      return { retry: cur.retry, continue: cur.continue, failStreak: cur.failStreak || 0 };
    },
    /** 用户手动续过的 seq（force 路径不占 takeContinue 名额，单独记一笔防自动续跑重复发）。 */
    tagManual(sessionId, seq) {
      const cur = slot(sessionId);
      if (cur && seq) cur.manualSeq = seq;
      return cur ? cur.manualSeq : 0;
    },
    manualTaken(sessionId, seq) {
      const cur = bySession.get(String(sessionId || ""));
      if (!cur || !cur.manualSeq) return false;
      return seq === undefined ? true : cur.manualSeq === seq;
    },
    /** 手动续跑（用户点按钮）：不吃 continueMax 预算，也不占 lastContinueSeq。 */
    bumpContinue(sessionId) {
      const cur = slot(sessionId);
      if (!cur) return 0;
      cur.continue += 1;
      return cur.continue;
    },
    reset(sessionId) {
      const id = String(sessionId || "");
      if (id) bySession.delete(id);
    },
    resetIfCompleted(sessionId, reason) {
      if (reason?.kind === "completed" || reason?.kind === "blocked") {
        const cur = bySession.get(String(sessionId || ""));
        if (cur) { cur.failStreak = 0; cur.failedSeqs = undefined; }
        this.reset(sessionId);
      }
    },
  };
}

export function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

/** 按 sessionId 拿活动 agent；宿主没装 agents 服务时返回 undefined。 */
export function agentOf(ctx, sessionId) {
  const agents = (() => {
    if (!ctx || typeof ctx.get !== "function") return undefined;
    try { return ctx.get("agents"); } catch { return undefined; }
  })();
  if (!agents || !sessionId) return undefined;
  try {
    const found = typeof agents.get === "function"
      ? agents.get(sessionId)
      : (typeof agents.agent === "function" ? agents.agent(sessionId) : undefined);
    return found || undefined;
  } catch {
    return undefined;
  }
}

export function inspectTurn(events) {
  const end = lastTurnEnd(events);
  const reason = end?.data?.reason || null;
  return {
    seq: end?.seq || 0,
    turn: end?.data?.turn || 0,
    reason,
    abnormal: isAbnormalReason(reason),
    userAbort: isUserAbort(reason),
    auto: shouldAutoContinue(reason),
  };
}

export function hasFreshHumanTurn(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  const after = end ? list.filter((event) => (event?.seq || 0) > end.seq) : list;
  return after.some((event) => {
    if (event?.type !== "user/message") return false;
    const kind = event.data?.source?.kind;
    return kind !== "plugin" && kind !== "dsh-purge";
  });
}

export function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox;
    if (!inbox) return false;
    if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
    if (typeof inbox.size === "number" && inbox.size > 0) return true;
    if (typeof inbox.length === "number" && inbox.length > 0) return true;
  } catch { /* ignore */ }
  return false;
}

export function sendContinue(agent, text) {
  if (!agent || typeof agent.followup !== "function") {
    return { ok: false, error: "No agent in this session to continue" };
  }
  try {
    agent.followup(makeContinueMessage(text));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

export function installContinueRetry(ctx, options = {}) {
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => normalizeConfig(options.config);
  const persist = typeof options.persist === "function" ? options.persist : null;
  const tracker = options.tracker || createTracker();
  const timers = new Set();

  function sessionIdOf(agent) {
    return agent?.id || agent?.session?.id || "";
  }

  function reasonKind(reason) {
    return String((reason && reason.kind) || "");
  }

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  function maybeAutoContinue(agent) {
    const cfg = getConfig();
    if (!cfg.autoContinue) return;
    const id = sessionIdOf(agent);
    if (!id) return;
    if (agent.status === "running" || inboxBusy(agent)) return;
    statusCache.delete(id); // 状态要变了，别让 900ms 缓存继续骗面板
    const events = sessionEventsOf(agent);
    if (hasFreshHumanTurn(events)) return;
    const info = inspectTurn(events);
    if (!info.auto) return;
    if (!tracker.takeContinue(id, info.seq, cfg.continueMax)) return;
    const sent = sendContinue(agent, cfg.continueText);
    if (!sent.ok) {
      tracker.refundContinue(id, info.seq);
      console.warn(`[dsh-purge] auto-continue send failed (session=${id}, seq=${info.seq}):`, sent.error);
    }
  }

  const offError = listen("agent/request-error", async (payload, next) => {
    const downstream = typeof next === "function" ? await next() : undefined;
    if (downstream?.kind === "retry") return downstream;
    const cfg = getConfig();
    if (!cfg.autoRetry) return downstream;
    if (!shouldAutoRetry(payload?.failure, payload?.signal)) return downstream;
    const id = sessionIdOf(payload?.agent);
    const key = `${payload?.turn || 0}:${payload?.step || 0}:${payload?.failure?.code || ""}`;
    if (!tracker.takeRetry(id, key, cfg.retryMax)) return downstream;
    // [方案2] 标记 retry pending,让下次 system-prompt/assemble 强制塞 inject
    // (消费一次后由 shouldInjectAssembly 清掉)。user 发消息自然塞,不需要;
    // retry 不是 user 触发,messages 结构没变,必须靠这个 flag 让 assemble 吃到。
    globalThis.__dshPurgeRetryPending = true;
    return { kind: "retry" };
  });

  const offStatus = listen("agent/status", (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    const id = sessionIdOf(agent);
    const events = sessionEventsOf(agent);
    if (payload.status === "running" && hasFreshHumanTurn(events)) tracker.reset(id);
    if (payload.status !== "idle") return;
    tracker.resetIfCompleted(id, inspectTurn(events).reason);
    schedule(() => maybeAutoContinue(agent), 280);
  });

  // 面板 ContinueButton 每 1200ms 轮询一次状态；snapshotEvents() 在长会话上不便宜，
  // 同一 session 900ms 内直接复用上一次结果。
  const statusCache = new Map();
  const STATUS_TTL = 900;

  /** 状态缓存的有效性指纹：事件条数 + 最后一条 turn/end 的 seq + agent 状态 + 关键配置。 */
  function statusFingerprint(agent, events, cfg) {
    const list = Array.isArray(events) ? events : [];
    const last = lastTurnEnd(list);
    return [
      agent ? String(agent.status || "") : "-",
      list.length,
      last ? last.seq : 0,
      cfg.continueMax,
      cfg.retryMax,
      cfg.autoContinue ? 1 : 0,
      cfg.autoRetry ? 1 : 0,
      cfg.continueText,
    ].join("|");
  }

  /** 面板 GET /dsh-purge/continue?sessionId= 的载荷。不创建 tracker slot。 */
  function statusOf(sessionId) {
    const cfg = getConfig();
    const id = String(sessionId || "");
    const cached = statusCache.get(id);
    // 光看 TTL 不够：同一 session 里上一轮刚失败、agent 刚 idle 时，
    // 900ms 内的旧值会把 canContinue 说成 false，按钮就不出来。缓存里存一份
    // "事件数 + agent 状态 + 配置指纹"，任何一项变了就重算。
    const agentNow = id ? agentOf(ctx, id) : undefined;
    if (cached && Date.now() - cached.at < STATUS_TTL) {
      const eventsNow = agentNow ? sessionEventsOf(agentNow) : [];
      const fingerprint = statusFingerprint(agentNow, eventsNow, cfg);
      if (cached.fingerprint === fingerprint) return cached.value;
    }
    const agent = agentNow;
    const used = tracker.peek(id);
    const events = agent ? sessionEventsOf(agent) : [];
    const info = inspectTurn(events);
    const running = Boolean(agent && agent.status === "running");
    const fresh = hasFreshHumanTurn(events);
    const busy = running || inboxBusy(agent);
    const payload = {
      ok: true,
      sessionId: id,
      found: Boolean(agent),
      running,
      canContinue: Boolean(agent) && !busy && !fresh && info.auto && used.continue < cfg.continueMax,
      continueMax: cfg.continueMax,
      continueUsed: used.continue,
      retryUsed: used.retry,
      retryMax: cfg.retryMax,
      autoContinue: cfg.autoContinue,
      autoRetry: cfg.autoRetry,
      continueText: cfg.continueText,
      continueFailStreak: used.failStreak,
      turn: info.turn,
      turnReason: reasonKind(info.reason),
      turnCode: failureCodeOf(info.reason),
    };
    statusCache.set(id, { at: Date.now(), value: payload, fingerprint: statusFingerprint(agent, events, cfg) });
    if (statusCache.size > 64) {
      const oldest = statusCache.keys().next().value;
      if (oldest !== undefined) statusCache.delete(oldest);
    }
    return payload;
  }

  /** 面板 POST /dsh-purge/continue —— 用户主动点「继续」。 */
  function continueNow(sessionId, opts = {}) {
    const force = opts.force === true;
    const cfg = getConfig();
    const id = String(sessionId || "");
    statusCache.delete(id); // 发完立刻重算，别让 900ms 缓存把 canContinue 显示成旧值
    if (!id) return { ok: false, error: "需要 sessionId" };
    const agent = agentOf(ctx, id);
    if (!agent) return { ok: false, error: "这个会话当前没有活动 agent（可能已归档或宿主刚重启）" };
    if (agent.status === "running") return { ok: false, error: "当前回合还在跑，等它停下来再续" };
    if (inboxBusy(agent)) return { ok: false, error: "输入队列里还有没发出去的消息" };
    const events = sessionEventsOf(agent);
    if (!force && hasFreshHumanTurn(events)) {
      return { ok: false, error: "上一轮之后你已经发过新消息了，不需要续跑" };
    }
    const info = inspectTurn(events);
    const used = tracker.peek(id);
    // force 续跑不占 takeContinue 名额，这里单独记一笔，避免自动续跑对同一轮再发一次
    if (!force && tracker.manualTaken(id, info.seq)) {
      return { ok: false, error: "这一轮你已经手动续过了" };
    }
    if (!force) {
      if (!info.auto) {
        return {
          ok: false,
          error: info.userAbort ? "上一轮是你自己中断的，不自动续跑" : "上一轮不是可续跑的失败状态",
        };
      }
      if (used.continue >= cfg.continueMax) {
        return { ok: false, error: `续跑次数已用完（${used.continue}/${cfg.continueMax}）` };
      }
      if (!tracker.takeContinue(id, info.seq, cfg.continueMax)) {
        return { ok: false, error: "这一轮已经续过了，不重复发" };
      }
    }
    const sent = sendContinue(agent, cfg.continueText);
    if (!sent.ok) {
      if (!force) tracker.refundContinue(id, info.seq);
      statusCache.delete(id);
      return { ok: false, error: sent.error };
    }
    if (force) tracker.tagManual(id, info.seq);
    const next = tracker.peek(id).continue;
    return { ok: true, sessionId: id, used: next, continueMax: cfg.continueMax, text: cfg.continueText };
  }

  return {
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { offError?.(); } catch { /* ignore */ }
      try { offStatus?.(); } catch { /* ignore */ }
    },
    config: () => getConfig(),
    /** 面板 POST /dsh-purge/continue/settings：合并当前值 → 归一化 → 交给宿主落盘。 */
    saveSettings(patch) {
      if (!persist) return { ok: false, error: "宿主没有提供设置持久化入口" };
      const cur = getConfig();
      const src = patch && typeof patch === "object" ? patch : {};
      return persist(normalizeConfig({ ...cur, ...src }));
    },
    status: statusOf,
    continueNow,
    tracker,
  };
}
