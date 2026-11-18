/**
 * /dsh-purge/continue* 的 HTTP 桥。
 *
 * 上游 1.1.90 的 client.js 一直在调这四条，但宿主侧从来没有对应路由
 * （点了必然 404 → 面板「继续」按钮永远失败）。这里补上，并把逻辑全部
 * 委托给 continue-retry.js 的运行时，避免两边各算一套状态。
 *
 *   GET  /dsh-purge/continue?sessionId=<id>   状态：canContinue / continueUsed / 失败原因
 *   POST /dsh-purge/continue                  { sessionId, force? } → 发一条「继续」
 *   GET  /dsh-purge/continue/settings         自动重试 / 自动续跑配置
 *   POST /dsh-purge/continue/settings         保存配置（原子写 continue-retry.json）
 */

const PREFIX = "/dsh-purge/continue";
const MAX_BODY = 256 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  // 宿主可能已经消费过请求体（或在 route 包装里把 stream 读空了），
  // 这时监听 'end' 永远等不到，直接按空体返回，别让 Promise 悬着。
  if (request.readableEnded || request.complete) return Promise.resolve({});
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        finish({});
        try { request.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return finish({});
      try {
        const parsed = JSON.parse(raw);
        finish(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        finish({});
      }
    });
    request.on("error", () => finish({}));
  });
}

/**
 * @param {() => object|undefined} getRuntime 取当前 apply 作用域里的 continue 运行时。
 * @returns {(request, response) => Promise<void>}
 */
export function continueHttpHandler(getRuntime) {
  return async function handleContinueHttp(request, response) {
    const url = new URL(String(request.url || PREFIX), "http://127.0.0.1");
    const tail = url.pathname.slice(PREFIX.length).replace(/\/+$/, "");
    const runtime = typeof getRuntime === "function" ? getRuntime() : undefined;
    if (!runtime) {
      sendJson(response, 503, { ok: false, error: "continue 运行时还没准备好（插件未 attach）" });
      return;
    }

    if (tail === "/settings") {
      if (request.method === "GET") {
        const cfg = runtime.config ? runtime.config() : {};
        sendJson(response, 200, { ok: true, ...cfg });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const saved = runtime.saveSettings ? runtime.saveSettings(body) : { ok: false, error: "saveSettings 未注册" };
        if (!saved || saved.ok === false) {
          sendJson(response, 500, { ok: false, error: (saved && saved.error) || "保存失败" });
          return;
        }
        sendJson(response, 200, { ok: true, ...(saved.settings || {}) });
        return;
      }
      sendJson(response, 405, { ok: false, error: "只支持 GET / POST" });
      return;
    }

    if (tail === "") {
      if (request.method === "GET") {
        const sessionId = String(url.searchParams.get("sessionId") || "").trim();
        sendJson(response, 200, runtime.status ? runtime.status(sessionId) : { ok: false, error: "status 未注册" });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const sessionId = String(body?.sessionId || "").trim();
        if (!sessionId) {
          sendJson(response, 400, { ok: false, error: "需要 sessionId" });
          return;
        }
        // 用 await 兜住两种情况：continueNow 返回 Promise 时不会再序列化成 {}，
        // 抛错也会变成一条可读的 409。
        let result;
        try {
          result = runtime.continueNow
            ? await runtime.continueNow(sessionId, { force: body?.force === true })
            : { ok: false, error: "continueNow 未注册" };
        } catch (error) {
          result = { ok: false, error: String((error && error.message) || error) };
        }
        sendJson(response, result && result.ok ? 200 : 409, result);
        return;
      }
      sendJson(response, 405, { ok: false, error: "只支持 GET / POST" });
      return;
    }

    sendJson(response, 404, { ok: false, error: "未知的 continue 接口: " + tail });
  };
}
