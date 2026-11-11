import { i as readPrivateFile, n as atomicText, r as privateDirectory, t as atomicJson } from "./private-files-BEfKAzcX.js";
import { t as LogHistory } from "./log-history-BWDSedZZ.js";
import { a as maskSecrets, i as sanitize, n as LOG_LEVELS, r as isLogInput, t as HOST_LOG_PREFIX } from "./log-record-Bjy6LjKi.js";
import { i as SAFE_MODE_PREFERENCES, n as DEFAULT_PROFILE, r as NATIVE_ACCESS_HEADER, t as DEFAULT_PREFERENCES } from "./desktop-contract-Dfyxcsjh.js";
import { _ as cleanupDisposableTree, i as DEFAULT_FEATURES, s as NextProfiles, t as NextRecovery } from "./recovery-LdPrVBtQ.js";
import { n as DesktopHostProcess, t as DesktopHostFatalError } from "./host-process-qyOxsMrW.js";
import { a as DesktopPreferenceStore, o as parsePreferences, t as SYSTEM_PROXY_ENV } from "./system-proxy-De6h1zuB.js";
import { authenticateWebHost } from "./web-document.js";
import { mkdtempSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:https";
import { Socket, isIPv4 } from "node:net";
//#region src/startup-error.ts
/** Serializable Desktop failure diagnostics. */
/**
* Preserve nested diagnostics when sending failures to a renderer.
* @param error - Startup or runtime failure.
* @returns Serializable error state.
*/
function desktopErrorState(error) {
	return {
		phase: "error",
		message: error instanceof AggregateError ? [error.message, ...error.errors.map((item) => desktopErrorState(item).message)].join("\n") : error instanceof Error ? error.message : String(error)
	};
}
//#endregion
//#region src/backend-controller.ts
/** Owns one backend startup and its quiescent teardown independently of windows. */
/** The error state for one failure: rendered message plus the failure itself. */
function errorState(failure) {
	return {
		...desktopErrorState(failure),
		failure
	};
}
/** Serializes retries and prevents children from outliving a closed window. */
var DesktopBackendController = class {
	createHost;
	publish;
	current = { phase: "starting" };
	attempt;
	pending;
	stopping;
	closed = false;
	/**
	* @param createHost - Allocate a child and route its fatal failures to the supplied callback.
	* @param publish - Receive availability changes until the controller closes.
	*/
	constructor(createHost, publish) {
		this.createHost = createHost;
		this.publish = publish;
	}
	/** Current availability, including the last startup or child failure. */
	get state() {
		return this.current;
	}
	/** Child available to application requests; absent during startup and teardown. */
	get host() {
		return !this.closed && !this.attempt?.cancelled && this.current.phase === "ready" ? this.attempt?.host : void 0;
	}
	/**
	* Prepare the profile and start one child; concurrent callers share the attempt.
	* @param prepare - Profile preparation that must finish before spawning.
	* @returns Completion of startup, rejecting on preparation, startup, or cleanup failure.
	*/
	start(prepare) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("desktop backend is closed"));
		if (this.stopping !== void 0) return Promise.reject(/* @__PURE__ */ new Error("desktop backend is stopping"));
		if (this.pending !== void 0) return this.pending;
		if (this.current.phase === "ready") return Promise.resolve();
		const previous = this.attempt;
		const attempt = {
			cancelled: false,
			...previous?.host === void 0 ? {} : { host: previous.host },
			...previous?.cleanup === void 0 ? {} : { cleanup: previous.cleanup }
		};
		this.attempt = attempt;
		this.update({ phase: "starting" });
		const pending = Promise.resolve().then(async () => {
			let replacing = previous !== void 0;
			try {
				if (replacing) await this.cleanup(attempt);
				delete attempt.cleanup;
				delete attempt.host;
				replacing = false;
				if (attempt.cancelled) return;
				await prepare();
				if (attempt.cancelled) return;
				const host = this.createHost((error) => {
					this.failed(attempt, error);
				});
				attempt.host = host;
				await host.start();
				if (attempt.failure !== void 0) throw attempt.failure;
				if (!attempt.cancelled) this.update({ phase: "ready" });
			} catch (error) {
				if (replacing) delete attempt.cleanup;
				const cancelled = attempt.cancelled;
				attempt.cancelled = true;
				let failure = error;
				try {
					if (!replacing) await this.cleanup(attempt);
				} catch (cleanupError) {
					if (cleanupError !== error) failure = new AggregateError([error, cleanupError], "desktop backend startup and cleanup failed");
				}
				if (!cancelled) this.update(errorState(failure));
				throw failure;
			}
		}).finally(() => {
			if (this.pending === pending) this.pending = void 0;
		});
		this.pending = pending;
		return pending;
	}
	/**
	* Stop pending preparation and the child before allowing another start.
	* @returns Completion of pending work and child exit; rejects if cleanup fails.
	*/
	stop() {
		if (this.stopping !== void 0) return this.stopping;
		const attempt = this.attempt;
		if (attempt !== void 0) attempt.cancelled = true;
		if (!this.closed) this.update({ phase: "starting" });
		const pending = this.pending;
		const stopping = Promise.allSettled([attempt === void 0 ? Promise.resolve() : this.cleanup(attempt), pending]).then((results) => {
			const cleanup = results[0];
			if (cleanup.status === "rejected") throw cleanup.reason;
			if (this.attempt === attempt) this.attempt = void 0;
		}).finally(() => {
			if (this.stopping === stopping) this.stopping = void 0;
		});
		this.stopping = stopping;
		return stopping;
	}
	/**
	* Permanently prevent startup and suppress further availability notifications.
	* @returns Completion of pending work and child exit; rejects if cleanup fails.
	*/
	close() {
		this.closed = true;
		return this.stop();
	}
	cleanup(attempt) {
		if (attempt.cleanup === void 0) {
			const cleanup = Promise.resolve().then(async () => {
				await attempt.host?.stop();
			}).catch((error) => {
				if (attempt.cleanup === cleanup) delete attempt.cleanup;
				throw error;
			});
			attempt.cleanup = cleanup;
		}
		return attempt.cleanup;
	}
	failed(attempt, error) {
		if (this.attempt !== attempt || attempt.cancelled) return;
		attempt.failure = error;
		if (this.current.phase !== "ready") return;
		attempt.cancelled = true;
		const cleanup = this.cleanup(attempt);
		this.update(errorState(error));
		cleanup.catch((cleanupError) => {
			if (this.attempt === attempt) this.update(errorState(new AggregateError([error, cleanupError], "Desktop backend failed and could not stop")));
		});
	}
	update(state) {
		if (this.closed) return;
		this.current = state;
		try {
			this.publish(state);
		} catch (error) {
			console.error("desktop backend state listener failed", error);
		}
	}
};
//#endregion
//#region src/diagnostics.ts
/** Recent readable diagnostics plus private structured history. */
const LIMIT = 128 * 1024;
const MAX_PENDING = 1024 * 1024;
var DesktopDiagnostics = class {
	file;
	runId = randomUUID();
	marker;
	history;
	text = "";
	partial = /* @__PURE__ */ new Map();
	pending = [];
	pendingBytes = 0;
	sequence = 0;
	storageError;
	droppedRecords = 0;
	active = /* @__PURE__ */ new Map();
	timer;
	level = "info";
	developer = false;
	constructor(home, options) {
		const directory = join(home, "logs");
		this.file = join(directory, "desktop-next.log");
		this.marker = join(directory, "active-run.json");
		try {
			this.text = readPrivateFile(this.file, LIMIT * 4)?.slice(-131072) ?? "";
		} catch {}
		try {
			this.history = new LogHistory(directory, options);
		} catch {}
	}
	/** Called only by the single-instance owner, after preferences are loaded. */
	begin(fields) {
		try {
			const previous = readPrivateFile(this.marker);
			if (previous) {
				const run = JSON.parse(previous);
				if (run.clean !== true) this.record({
					source: "electron",
					event: "run.previous-unclean",
					level: "warn",
					fields: {
						previousRunId: typeof run.runId === "string" ? run.runId : "unknown",
						previousStarted: typeof run.started === "string" ? run.started : "unknown"
					}
				});
			}
			atomicJson(this.marker, {
				runId: this.runId,
				pid: process.pid,
				started: (/* @__PURE__ */ new Date()).toISOString(),
				clean: false
			});
		} catch (error) {
			this.record({
				source: "logging",
				event: "run.marker-failed",
				level: "warn",
				error
			});
		}
		this.record({
			source: "electron",
			event: "run.start",
			fields
		});
		this.flush();
	}
	end(clean) {
		this.record({
			source: "electron",
			event: clean ? "run.end" : "run.forced-exit",
			level: clean ? "info" : "error",
			fields: { pendingOperations: this.active.size }
		});
		this.flush();
		try {
			atomicJson(this.marker, {
				runId: this.runId,
				pid: process.pid,
				ended: (/* @__PURE__ */ new Date()).toISOString(),
				clean
			});
		} catch {}
	}
	record(input) {
		const level = input.level ?? "info";
		if (input.developer && (!this.developer || LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level))) return;
		if (input.operationId) {
			if (input.event.endsWith(".start")) this.active.set(input.operationId, {
				source: input.source,
				event: input.event.slice(0, -6),
				started: Date.now()
			});
			else if (/\.(complete|failed)$/u.test(input.event)) this.active.delete(input.operationId);
		}
		if (this.active.size > 4096) {
			this.active.delete(this.active.keys().next().value);
			this.droppedRecords++;
		}
		const record = sanitize({
			time: (/* @__PURE__ */ new Date()).toISOString(),
			runId: this.runId,
			sequence: ++this.sequence,
			pid: input.pid ?? process.pid,
			source: input.source,
			event: input.event,
			level,
			message: input.message ?? "",
			developer: input.developer ?? false,
			operationId: input.operationId,
			fields: input.fields,
			error: input.error
		});
		const line = JSON.stringify(record);
		this.pending.push(line);
		this.pendingBytes += Buffer.byteLength(line) + 1;
		const detail = record.error === void 0 ? "" : ` ${JSON.stringify(record.error)}`;
		this.text = (this.text + `${record.time} [${level}] ${record.message ? record.message + " " : ""}[${record.source}] ${record.event}${record.operationId ? ` (${record.operationId})` : ""}${record.fields ? ` ${JSON.stringify(record.fields)}` : ""}${detail}\n`).slice(-131072);
		if (level === "error" || this.pendingBytes >= MAX_PENDING) this.flush();
		else {
			this.timer ??= setTimeout(() => this.flush(), 200);
			this.timer.unref();
		}
	}
	append(message, level = "info") {
		if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
		this.record({
			source: "desktop",
			event: "message",
			message,
			level,
			developer: level === "debug"
		});
	}
	operation(source, event, fields, developer = false) {
		const operationId = randomUUID();
		const started = Date.now();
		this.active.set(operationId, {
			source,
			event,
			started
		});
		this.record({
			source,
			event: `${event}.start`,
			fields,
			operationId,
			developer
		});
		let finished = false;
		return (error) => {
			if (finished) return;
			finished = true;
			this.active.delete(operationId);
			this.record({
				source,
				event: `${event}.${error === void 0 ? "complete" : "failed"}`,
				operationId,
				fields: {
					...fields,
					durationMs: Date.now() - started
				},
				developer: error === void 0 && developer,
				level: error === void 0 ? "info" : "error",
				error
			});
		};
	}
	pendingOperations() {
		return [...this.active].map(([operationId, operation]) => ({
			operationId,
			source: operation.source,
			event: operation.event,
			durationMs: Date.now() - operation.started
		}));
	}
	/** Independent buffers prevent stdout/stderr fragments from being joined together. */
	hostChunk(chunk, stream = "stdout", pid) {
		const key = `${pid ?? 0}:${stream}`;
		const buffer = this.partial.get(key) ?? {
			text: "",
			dropping: false,
			pid
		};
		for (const part of chunk.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
			const complete = part.endsWith("\n");
			if (!buffer.dropping) if (buffer.text.length + part.length > LIMIT) {
				buffer.text = "";
				buffer.dropping = true;
				this.record({
					source: `host.${stream}`,
					event: "line.omitted",
					level: "warn",
					pid,
					message: "Oversized process output line omitted"
				});
			} else buffer.text += part;
			if (complete) {
				if (!buffer.dropping) this.hostLine(buffer.text.replace(/\r?\n$/u, ""), stream, pid);
				buffer.text = "";
				buffer.dropping = false;
			}
		}
		this.partial.set(key, buffer);
	}
	hostClosed(pid) {
		for (const [key, buffer] of this.partial) {
			if (buffer.pid !== pid) continue;
			if (buffer.text) this.hostLine(buffer.text, key.slice(key.indexOf(":") + 1), pid);
			this.partial.delete(key);
		}
		this.flush();
	}
	hostLine(line, stream, pid) {
		if (line.startsWith("@@dsh-next-log ")) try {
			const input = JSON.parse(line.slice(HOST_LOG_PREFIX.length));
			if (isLogInput(input)) {
				this.record({
					...input,
					pid
				});
				return;
			}
		} catch {}
		const level = /\b(error|fatal)\b/iu.test(line) ? "error" : /\bwarn/iu.test(line) ? "warn" : /\bdebug\b/iu.test(line) ? "debug" : "info";
		if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level)) this.record({
			source: `host.${stream}`,
			event: "output",
			level,
			message: line,
			pid,
			developer: level === "debug"
		});
	}
	snapshot() {
		return maskSecrets(this.text + [...this.partial.values()].filter((buffer) => buffer.text).map((buffer) => `\n${buffer.text}`).join("")).slice(-131072);
	}
	flush() {
		clearTimeout(this.timer);
		this.timer = void 0;
		try {
			if (this.pending.length) {
				this.history ??= new LogHistory(join(this.file, ".."));
				this.history.append(this.pending);
				this.pending = [];
				this.pendingBytes = 0;
			}
			atomicText(this.file, this.snapshot());
			this.storageError = void 0;
		} catch (error) {
			this.storageError = maskSecrets(String(error)).slice(0, 2048);
			while (this.pendingBytes > MAX_PENDING && this.pending.length) {
				this.pendingBytes -= Buffer.byteLength(this.pending.shift()) + 1;
				this.droppedRecords++;
			}
		}
	}
	export(state) {
		return JSON.stringify({
			format: "dsh-desktop-next-diagnostics",
			version: 2,
			created: (/* @__PURE__ */ new Date()).toISOString(),
			runId: this.runId,
			application: {
				version: state.version,
				platform: state.platform,
				versions: process.versions
			},
			runtime: sanitize({
				profile: state.selected,
				profiles: state.profiles,
				phase: state.phase,
				safeMode: state.safeMode,
				failure: state.failure,
				features: state.features,
				preferences: state.preferences,
				trayAvailable: state.trayAvailable,
				browserUrl: state.browserUrl,
				lan: state.lan
			}),
			logging: {
				storageError: this.storageError ?? null,
				droppedRecords: this.droppedRecords
			},
			pendingOperations: this.pendingOperations(),
			log: this.snapshot()
		}, null, 2) + "\n";
	}
	/** Export history off the Electron main thread; terminate stalled workers. */
	exportTo(file, state) {
		this.flush();
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const worker = new Worker(new URL(`./diagnostics-export.${extension}`, import.meta.url), {
			workerData: {
				kind: "dsh-next-diagnostics-export",
				directory: join(this.file, ".."),
				file,
				summary: this.export(state)
			},
			resourceLimits: { maxOldGenerationSizeMb: 512 }
		});
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				worker.terminate().catch(() => {});
				if (error === void 0) resolve();
				else reject(error);
			};
			const timer = setTimeout(() => finish(/* @__PURE__ */ new Error("Diagnostic export exceeded 60 seconds")), 6e4);
			worker.once("message", (result) => finish(result.ok ? void 0 : new Error(result.error)));
			worker.once("error", finish);
			worker.once("exit", (code) => finish(/* @__PURE__ */ new Error(`Diagnostic export worker exited before completion (${code})`)));
		});
	}
};
//#endregion
//#region src/lan-https-ingress.ts
/** Hot-swappable HTTPS/WSS edge for the loopback-only upstream WebServer. */
const EDGE_HOST = "0.0.0.0";
const TARGET_HOST = "127.0.0.1";
const FORBIDDEN_REQUEST_HEADER = NATIVE_ACCESS_HEADER.toLowerCase();
function exactPort(value, allowZero, label) {
	const minimum = allowZero ? 0 : 1;
	if (!Number.isSafeInteger(value) || value < minimum || value > 65535) throw new TypeError(`dsh-desktop-next: ${label} must be an integer from ${String(minimum)} through 65535`);
	return value;
}
function canonicalIpv4(value) {
	if (!isIPv4(value)) throw new TypeError(`dsh-desktop-next: invalid LAN HTTPS IPv4 address ${JSON.stringify(value)}`);
	const canonical = value.split(".").map((part) => String(Number(part))).join(".");
	if (canonical !== value) throw new TypeError(`dsh-desktop-next: LAN HTTPS IPv4 address must be canonical: ${JSON.stringify(value)}`);
	return canonical;
}
function normalizeAddresses(values) {
	return Object.freeze([...new Set(values.map(canonicalIpv4))].sort((left, right) => left.localeCompare(right)));
}
function copyTlsValue(value, label) {
	if (typeof value === "string" && value.length === 0 || Buffer.isBuffer(value) && value.length === 0) throw new TypeError(`dsh-desktop-next: LAN HTTPS ${label} must not be empty`);
	return Buffer.isBuffer(value) ? Buffer.from(value) : value;
}
function errorCode(cause) {
	const code = cause?.code;
	if (typeof code === "string" && code.length > 0) return code;
	if (cause instanceof Error && cause.name.length > 0) return cause.name;
	return "UNKNOWN";
}
function externalHost(headers) {
	const raw = headers.host;
	if (typeof raw !== "string") return void 0;
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/u.exec(raw);
	if (match === null) return void 0;
	const address = match[1];
	if (address === void 0 || !isIPv4(address)) return void 0;
	if (address.split(".").map((part) => String(Number(part))).join(".") !== address) return void 0;
	const port = match[2];
	if (port !== void 0 && (Number(port) < 1 || Number(port) > 65535 || String(Number(port)) !== port)) return void 0;
	return address;
}
function isCrossSite(headers) {
	const raw = headers["sec-fetch-site"];
	return (Array.isArray(raw) ? raw : raw === void 0 ? [] : [raw]).some((value) => value.split(",").some((item) => item.trim().toLowerCase() === "cross-site"));
}
function permits(headers, allowedAddresses) {
	const host = externalHost(headers);
	return host !== void 0 && allowedAddresses.has(host) && !isCrossSite(headers);
}
function isForwardingIdentityHeader(name) {
	const lower = name.toLowerCase();
	return lower === FORBIDDEN_REQUEST_HEADER || lower === "forwarded" || lower.startsWith("x-forwarded-");
}
function sanitizedHeaders(headers) {
	const sanitized = {};
	for (const [name, value] of Object.entries(headers)) if (!isForwardingIdentityHeader(name) && value !== void 0) sanitized[name] = value;
	return sanitized;
}
function reject(res, statusCode, body) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.statusCode = statusCode;
	res.setHeader("cache-control", "no-store");
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.setHeader("content-length", Buffer.byteLength(body));
	res.setHeader("x-content-type-options", "nosniff");
	res.end(body);
}
function rejectUpgrade(socket, statusCode, reason, body) {
	socket.end([
		`HTTP/1.1 ${String(statusCode)} ${reason}`,
		"Connection: close",
		"Cache-Control: no-store",
		"Content-Type: text/plain; charset=utf-8",
		"X-Content-Type-Options: nosniff",
		`Content-Length: ${String(Buffer.byteLength(body))}`,
		"",
		body
	].join("\r\n"));
}
function secureCookie(cookie) {
	return /(?:^|;)\s*secure\s*(?:;|$)/iu.test(cookie) ? cookie : `${cookie}; Secure`;
}
function responseHeaders(headers) {
	const copied = {};
	for (const [name, value] of Object.entries(headers)) if (value !== void 0) copied[name] = value;
	const cookies = headers["set-cookie"];
	if (cookies !== void 0) copied["set-cookie"] = cookies.map(secureCookie);
	return copied;
}
function rawUpgradeRequest(request, headers) {
	const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
	for (const [name, value] of Object.entries(headers)) if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
	else if (value !== void 0) lines.push(`${name}: ${value}`);
	lines.push("", "");
	return lines.join("\r\n");
}
function frozenSnapshot$1(state, actualPort, addresses, caFingerprint, failure) {
	return Object.freeze({
		state,
		actualPort,
		addresses,
		caFingerprint,
		errorCode: failure
	});
}
/**
* HTTPS/WSS ingress that can be enabled and disabled without rebuilding the DSH
* Host generation. The HTTP target is deliberately fixed to loopback.
*/
var LanHttpsIngress = class {
	targetPort;
	requestedPort;
	key;
	cert;
	caFingerprint;
	addresses;
	allowedAddresses;
	sockets = /* @__PURE__ */ new Set();
	server = null;
	current;
	serial = Promise.resolve();
	constructor(options) {
		this.targetPort = exactPort(options.targetPort, false, "LAN HTTPS target port");
		this.requestedPort = exactPort(options.requestedPort, true, "LAN HTTPS requested port");
		this.key = copyTlsValue(options.key, "private key");
		this.cert = copyTlsValue(options.cert, "certificate");
		const fingerprint = options.caFingerprint.trim();
		if (fingerprint.length === 0) throw new TypeError("dsh-desktop-next: LAN HTTPS CA fingerprint must not be empty");
		this.caFingerprint = fingerprint;
		this.addresses = normalizeAddresses(options.allowedAddresses);
		this.allowedAddresses = new Set(this.addresses);
		this.current = frozenSnapshot$1("inactive", null, this.addresses, this.caFingerprint, null);
	}
	snapshot() {
		return this.current;
	}
	setEnabled(enabled) {
		const transition = this.serial.then(async () => {
			if (enabled) await this.startInternal();
			else await this.stopInternal();
			return this.current;
		});
		this.serial = transition.then(() => void 0, () => void 0);
		return transition;
	}
	stop() {
		return this.setEnabled(false);
	}
	track(socket) {
		this.sockets.add(socket);
		socket.once("close", () => this.sockets.delete(socket));
	}
	proxyHttp(request$1, response) {
		if (!permits(request$1.headers, this.allowedAddresses)) {
			request$1.resume();
			reject(response, 403, "forbidden");
			return;
		}
		const proxyRequest = request({
			host: TARGET_HOST,
			port: this.targetPort,
			method: request$1.method,
			path: request$1.url,
			headers: sanitizedHeaders(request$1.headers)
		});
		proxyRequest.once("socket", (socket) => this.track(socket));
		proxyRequest.once("response", (proxyResponse) => {
			if (response.destroyed) {
				proxyResponse.destroy();
				return;
			}
			response.writeHead(proxyResponse.statusCode ?? 502, responseHeaders(proxyResponse.headers));
			proxyResponse.pipe(response);
		});
		proxyRequest.once("error", () => reject(response, 502, "bad gateway"));
		request$1.once("aborted", () => proxyRequest.destroy());
		response.once("close", () => {
			if (!response.writableEnded) proxyRequest.destroy();
		});
		request$1.pipe(proxyRequest);
	}
	proxyUpgrade(request, downstream, head) {
		if (!permits(request.headers, this.allowedAddresses)) {
			rejectUpgrade(downstream, 403, "Forbidden", "forbidden");
			return;
		}
		downstream.pause();
		const upstream = new Socket();
		this.track(upstream);
		let connected = false;
		upstream.once("connect", () => {
			connected = true;
			upstream.write(rawUpgradeRequest(request, sanitizedHeaders(request.headers)));
			if (head.length > 0) upstream.write(head);
			downstream.pipe(upstream).pipe(downstream);
			downstream.resume();
		});
		upstream.once("error", () => {
			if (!connected) rejectUpgrade(downstream, 502, "Bad Gateway", "bad gateway");
			else downstream.destroy();
		});
		downstream.once("error", () => upstream.destroy());
		downstream.once("close", () => upstream.destroy());
		upstream.connect(this.targetPort, TARGET_HOST);
	}
	async startInternal() {
		if (this.current.state === "ready" || this.current.state === "starting") return;
		this.current = frozenSnapshot$1("starting", null, this.addresses, this.caFingerprint, null);
		let server;
		try {
			server = createServer({
				key: this.key,
				cert: this.cert,
				minVersion: "TLSv1.2"
			}, (request, response) => {
				this.proxyHttp(request, response);
			});
			this.server = server;
			server.on("connection", (socket) => this.track(socket));
			server.on("upgrade", (request, socket, head) => this.proxyUpgrade(request, socket, head));
			server.on("clientError", (_error, socket) => socket.destroy());
			server.on("tlsClientError", () => {});
			await new Promise((resolve, rejectListen) => {
				const failed = (cause) => {
					server.off("listening", listening);
					rejectListen(cause);
				};
				const listening = () => {
					server.off("error", failed);
					resolve();
				};
				server.once("error", failed);
				server.once("listening", listening);
				server.listen(this.requestedPort, EDGE_HOST);
			});
			const bound = server.address();
			if (bound === null || typeof bound === "string") throw new Error("LAN HTTPS ingress did not expose a TCP address");
			this.current = frozenSnapshot$1("ready", bound.port, this.addresses, this.caFingerprint, null);
		} catch (cause) {
			if (this.server !== null) try {
				this.server.close();
			} catch {}
			this.server = null;
			for (const socket of this.sockets) socket.destroy();
			this.sockets.clear();
			this.current = frozenSnapshot$1("failed", null, this.addresses, this.caFingerprint, errorCode(cause));
		}
	}
	async stopInternal() {
		const server = this.server;
		this.server = null;
		if (server !== null) {
			const closed = new Promise((resolve) => {
				try {
					server.close(() => resolve());
				} catch {
					resolve();
				}
			});
			for (const socket of this.sockets) socket.destroy();
			server.closeAllConnections();
			await closed;
		} else for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.current = frozenSnapshot$1("inactive", null, this.addresses, this.caFingerprint, null);
	}
};
//#endregion
//#region src/lan-https-runtime.ts
function frozenSnapshot(state, addresses, caFingerprint, errorCode) {
	return Object.freeze({
		state,
		actualPort: null,
		addresses,
		caFingerprint,
		errorCode
	});
}
function projectIngress(snapshot) {
	return Object.freeze({
		state: snapshot.state,
		actualPort: snapshot.actualPort,
		addresses: snapshot.addresses,
		caFingerprint: snapshot.caFingerprint,
		errorCode: snapshot.errorCode
	});
}
/**
* Keeps TLS material outside Cordis config while letting the Desktop shell
* attach the HTTPS edge after the upstream loopback port is known.
*/
var DesktopLanHttpsRuntime = class {
	addresses;
	certificate;
	failureCode;
	prepareCertificate;
	serial = Promise.resolve();
	enabled = false;
	requestedPort;
	ingress;
	targetPort;
	current;
	constructor(options) {
		this.addresses = Object.freeze([...options.addresses]);
		this.certificate = options.certificate;
		this.prepareCertificate = options.prepareCertificate;
		this.failureCode = options.failureCode ?? "certificate-unavailable";
		this.requestedPort = options.requestedPort ?? 0;
		this.current = frozenSnapshot("inactive", this.addresses, options.certificate?.caFingerprint ?? null, null);
	}
	get caCertificate() {
		return this.certificate?.caCertificate ?? null;
	}
	/** Attach exactly once to the actual loopback WebServer port. */
	attach(targetPort) {
		if (this.targetPort !== void 0) {
			if (this.targetPort === targetPort) return;
			throw new Error("dsh-desktop-next: LAN HTTPS runtime is already attached to another port");
		}
		this.targetPort = targetPort;
		this.attachIngress();
	}
	attachIngress() {
		const certificate = this.certificate;
		const targetPort = this.targetPort;
		if (certificate === void 0 || targetPort === void 0 || this.ingress !== void 0) return;
		this.ingress = new LanHttpsIngress({
			targetPort,
			requestedPort: this.requestedPort,
			key: certificate.key,
			cert: certificate.cert,
			caFingerprint: certificate.caFingerprint,
			allowedAddresses: certificate.addresses
		});
		this.current = projectIngress(this.ingress.snapshot());
	}
	snapshot() {
		const ingress = this.ingress;
		return ingress === void 0 ? this.current : projectIngress(ingress.snapshot());
	}
	/** Hot-enable or disable the edge without rebuilding the Host generation. */
	async setEnabled(enabled) {
		if (typeof enabled !== "boolean") throw new TypeError("dsh-desktop-next: LAN HTTPS enabled state must be a boolean");
		this.enabled = enabled;
		const transition = this.serial.then(async () => {
			if (enabled && this.enabled && this.certificate === void 0 && this.prepareCertificate !== void 0) {
				this.current = frozenSnapshot("starting", this.addresses, null, null);
				try {
					const result = await this.prepareCertificate();
					if ("certificate" in result) this.certificate = result.certificate;
					else this.failureCode = result.failureCode;
				} catch {
					this.failureCode = "certificate-unavailable";
				}
				this.attachIngress();
			}
			return this.applyEnabled(enabled && this.enabled);
		});
		this.serial = transition.then(() => void 0, () => void 0);
		return transition;
	}
	async applyEnabled(enabled) {
		const ingress = this.ingress;
		if (ingress === void 0) {
			this.current = enabled ? frozenSnapshot("failed", this.addresses, null, this.failureCode) : frozenSnapshot("inactive", this.addresses, null, null);
			return this.current;
		}
		this.current = projectIngress(await ingress.setEnabled(enabled));
		return this.current;
	}
	stop() {
		return this.setEnabled(false);
	}
};
//#endregion
//#region src/desktop-runtime.ts
/** Headless owner of the Host, desktop preferences, Profiles and recovery. */
var NextDesktopRuntime = class {
	options;
	profiles;
	recovery;
	settings;
	diagnostics;
	backend;
	preferences = { ...DEFAULT_PREFERENCES };
	selected = DEFAULT_PROFILE;
	safeMode = false;
	recoveryMode = false;
	busy = false;
	closing = false;
	failure = "";
	startup = Promise.resolve();
	/** Main-process transport only; never copied into a DesktopState. */
	auth;
	lan;
	safeHome;
	hostProcess;
	constructor(options) {
		this.options = options;
		this.profiles = new NextProfiles(options.home);
		this.recovery = new NextRecovery(this.profiles);
		this.settings = new DesktopPreferenceStore(options.stateHome ?? options.home);
		this.diagnostics = new DesktopDiagnostics(options.home);
		this.backend = new DesktopBackendController((onFailure) => this.createHost(onFailure), (state) => {
			this.diagnostics.record({
				source: "desktop.backend",
				event: "phase",
				fields: { phase: state.phase }
			});
			if (state.phase === "error" && !this.closing) {
				this.report(state.failure ?? state.message);
				const failure = state.failure;
				if (failure instanceof DesktopHostFatalError && failure.diagnostic !== void 0) this.diagnostics.append(maskSecrets(failure.diagnostic), "error");
			}
			this.options.onChange();
		});
	}
	initialize() {
		try {
			this.selected = this.profiles.active;
		} catch (error) {
			if (this.safeMode) this.diagnostics.append(`Original Profile selection is unavailable: ${String(error)}`, "warn");
			else this.report(error);
		}
		if (this.safeMode) this.preferences = { ...SAFE_MODE_PREFERENCES };
		else try {
			this.preferences = this.settings.read();
		} catch (error) {
			this.report(error);
		}
		this.diagnostics.level = this.preferences.logLevel;
		this.diagnostics.developer = this.preferences.developerLogging;
	}
	report(error) {
		if (this.closing) return;
		this.failure = maskSecrets(error instanceof Error ? error.message : String(error));
		this.diagnostics.record({
			source: "desktop",
			event: "runtime.failed",
			level: "error",
			error
		});
		this.options.onFailure();
		this.options.onChange();
	}
	start() {
		this.recoveryMode = false;
		this.failure = "";
		this.startup = this.backend.start(async () => {
			if (this.safeMode && !this.safeHome) {
				privateDirectory(this.recovery.directory);
				this.safeHome = mkdtempSync(join(this.recovery.directory, "safe-runtime-"));
				const safe = new NextProfiles(this.safeHome);
				safe.ensure(DEFAULT_PROFILE);
				safe.setFeatures(DEFAULT_PROFILE, {
					remoteControl: false,
					market: false
				});
			}
			if (this.safeMode) this.preferences = { ...SAFE_MODE_PREFERENCES };
			if (!this.safeMode) this.profiles.ensure(this.selected);
		});
		this.startup.catch(() => {});
		return this.startup;
	}
	async restart(change = () => {}) {
		await this.backend.stop();
		if (this.closing) return;
		const wasSafe = this.safeMode;
		await change();
		if (!this.safeMode) {
			this.cleanupSafeHome();
			if (wasSafe) this.preferences = new DesktopPreferenceStore(this.options.home).read();
		}
		await this.start();
	}
	/** Native repair tools target the original Profile; app tools follow the running environment. */
	terminalTarget(repair = false) {
		if (this.closing) throw new Error("Next is shutting down");
		const safe = this.safeMode && !repair;
		if (safe && !this.safeHome) throw new Error("Safe mode environment is not ready");
		const homeDir = safe ? this.safeHome : this.options.home;
		const profileName = safe ? DEFAULT_PROFILE : this.selected;
		return {
			homeDir,
			profileName,
			profileDir: new NextProfiles(homeDir).directory(profileName),
			mode: safe ? "safe" : repair || this.recoveryMode ? "recovery" : "normal"
		};
	}
	writePreferences(value) {
		if (this.safeMode) throw new Error("Desktop preferences are fixed in Safe Mode");
		this.preferences = this.settings.write(parsePreferences(value));
		this.diagnostics.level = this.preferences.logLevel;
		this.diagnostics.developer = this.preferences.developerLogging;
		this.options.onChange();
	}
	/**
	* Boot rows for a document that is loading now.
	* @returns The Host's current Web boot table, or the table captured at startup when the running
	* Host cannot answer. dsh 0.1.7 addresses boot bundles by revision and republishes the table
	* whenever a plugin registers, so replaying the startup table breaks every reload that follows
	* a plugin installation.
	*/
	async injections() {
		const auth = this.auth;
		if (!auth) throw new Error("Next Host is unavailable");
		try {
			return await (this.hostProcess?.collectInjections() ?? Promise.resolve(auth.injections));
		} catch (error) {
			this.diagnostics.append(`Web boot injections: ${String(error)}`, "warn");
			return auth.injections;
		}
	}
	/** Apply access toggles without stopping conversations or changing the renderer capability. */
	async applyPreferences(value) {
		const next = parsePreferences(value);
		if (this.backend.state.phase === "starting" && !this.recoveryMode && !this.safeMode) await this.startup.catch(() => {});
		if (this.closing) throw new Error("Next is shutting down");
		const previous = this.preferences;
		const host = this.hostProcess;
		const lan = this.lan;
		if (!host || !lan || !this.auth || this.safeMode || this.backend.state.phase !== "ready") {
			this.writePreferences(next);
			return;
		}
		const loggingChanged = next.developerLogging !== previous.developerLogging || next.logLevel !== previous.logLevel;
		const changed = next.browserAccess !== previous.browserAccess || next.networkExposure !== previous.networkExposure;
		try {
			if (loggingChanged) await host.setLogging(next);
			if (!changed) {
				this.writePreferences(next);
				return;
			}
			await host.setBrowserAccess(next.browserAccess);
			const edge = await lan.setEnabled(next.browserAccess && next.networkExposure === "lan");
			if (this.closing) throw new Error("Next is shutting down");
			this.writePreferences(next);
			if (edge.state === "failed") this.diagnostics.append(`LAN HTTPS: ${edge.errorCode}`, "warn");
		} catch (error) {
			if (!this.closing) try {
				if (loggingChanged) await host.setLogging(previous);
				await host.setBrowserAccess(previous.browserAccess);
				await lan.setEnabled(previous.browserAccess && previous.networkExposure === "lan");
			} catch {
				await this.backend.stop();
			}
			throw error;
		}
	}
	state() {
		let features = { ...DEFAULT_FEATURES };
		let profiles = [];
		let checkpoint = null;
		let failure = this.failure;
		try {
			profiles = this.profiles.list();
		} catch (error) {
			failure ||= maskSecrets(String(error));
		}
		if (!this.safeMode) try {
			features = this.profiles.features(this.selected);
		} catch (error) {
			failure ||= maskSecrets(String(error));
		}
		try {
			const saved = this.recovery.latest(this.selected);
			if (saved) checkpoint = { created: saved.created };
		} catch {}
		return {
			selected: this.selected,
			profiles,
			unavailableProfiles: profiles.filter((name) => !this.profiles.selectable(name)),
			features,
			preferences: { ...this.preferences },
			phase: this.recoveryMode ? "recovery" : !this.auth && failure ? "error" : this.backend.state.phase,
			busy: this.busy,
			failure,
			safeMode: this.safeMode,
			home: this.options.home,
			browserUrl: this.auth && this.preferences.browserAccess && !this.safeMode ? new URL(this.auth.url).origin : null,
			lan: this.lan?.snapshot() ?? null,
			checkpoint,
			logs: this.diagnostics.snapshot()
		};
	}
	browserLinks() {
		if (!this.auth || this.closing || this.recoveryMode || this.backend.state.phase !== "ready" || !this.preferences.browserAccess || this.safeMode) return {
			localUrl: null,
			lanUrls: []
		};
		const localUrl = new URL(this.auth.url).href;
		const edge = this.lan?.snapshot();
		return {
			localUrl,
			lanUrls: this.preferences.networkExposure === "lan" && edge?.state === "ready" && edge.actualPort ? edge.addresses.map((address) => {
				const url = new URL(localUrl);
				url.protocol = "https:";
				url.hostname = address;
				url.port = String(edge.actualPort);
				return url.href;
			}) : []
		};
	}
	browserLink(lan = false) {
		const links = this.browserLinks();
		const url = lan ? links.lanUrls[0] : links.localUrl;
		if (!url) throw new Error(lan ? "LAN HTTPS is unavailable" : "Browser access is unavailable");
		return url;
	}
	resolveBrowserLink(value) {
		const links = this.browserLinks();
		if (typeof value !== "string" || !value || value !== links.localUrl && !links.lanUrls.includes(value)) throw new Error("Browser address is unavailable");
		return value;
	}
	async close() {
		this.closing = true;
		const end = this.diagnostics.operation("desktop", "backend.close");
		try {
			await this.backend.close();
			end();
		} catch (error) {
			end(error);
			throw error;
		}
		this.cleanupSafeHome();
		this.diagnostics.flush();
	}
	cleanupSafeHome() {
		const home = this.safeHome;
		if (!home) return;
		this.safeHome = void 0;
		try {
			cleanupDisposableTree(home);
		} catch (error) {
			this.diagnostics.append(`Safe mode temporary directory cleanup failed (${home}): ${String(error)}`, "warn");
		}
	}
	createHost(onFailure) {
		const { options } = this;
		const actualHome = this.safeMode ? this.safeHome : options.home;
		const profile = this.safeMode ? DEFAULT_PROFILE : this.selected;
		const effective = this.safeMode ? { ...SAFE_MODE_PREFERENCES } : this.preferences;
		const addresses = options.addresses();
		const token = randomBytes(32).toString("base64url");
		const lan = new DesktopLanHttpsRuntime({
			addresses,
			requestedPort: effective.lanPort,
			prepareCertificate: async () => ({ certificate: await options.certificate(addresses) })
		});
		this.lan = lan;
		let stopped = false;
		const host = new DesktopHostProcess(options.executable, options.root, new NextProfiles(actualHome).directory(profile), void 0, {
			...process.env,
			DSH_HOME: actualHome,
			DSH_NEXT_NATIVE_TOKEN: token,
			DSH_NEXT_PREFERENCES: JSON.stringify(effective),
			DSH_NEXT_TRUSTED_HOSTS: JSON.stringify(addresses),
			[SYSTEM_PROXY_ENV]: JSON.stringify(options.systemProxy?.() ?? {}),
			...this.safeMode ? { DSH_TELEMETRY_DISABLED: "1" } : {}
		}, onFailure, options.primaryRuntime, void 0, join(options.root, "lib", "host.js"), options.onRestart, options.onNotification, (chunk, stream, pid) => this.diagnostics.hostChunk(chunk, stream, pid), options.onTerminal, options.onPermission, void 0, options.onPlatformLogin, (input) => {
			if (input.event === "exit") this.diagnostics.hostClosed(input.pid);
			this.diagnostics.record(input);
		});
		this.hostProcess = host;
		return {
			start: async () => {
				let timer;
				const started = this.diagnostics.operation("desktop", "host.start", {
					profile,
					safeMode: this.safeMode
				});
				try {
					const ready = await Promise.race([host.start(), new Promise((_resolve, reject) => {
						timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Host startup exceeded 300 seconds")), 3e5);
						timer.unref();
					})]).finally(() => clearTimeout(timer));
					const url = new URL(ready.url);
					if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Next Host must use loopback HTTP");
					if (!ready.injections) throw new Error("Next Host omitted Web boot injections");
					const cookie = await authenticateWebHost(ready.url, token);
					if (stopped) {
						started();
						return;
					}
					this.auth = {
						url: ready.url,
						cookie,
						token,
						injections: ready.injections
					};
					lan.attach(Number(url.port));
					if (effective.browserAccess && effective.networkExposure === "lan") {
						const edge = await lan.setEnabled(true);
						if (stopped) {
							await lan.stop();
							started();
							return;
						}
						if (edge.state === "failed") this.diagnostics.append(`LAN HTTPS: ${edge.errorCode}`, "warn");
					}
					if (!this.safeMode) try {
						this.recovery.checkpoint(this.selected);
					} catch (error) {
						this.diagnostics.append(`Recovery checkpoint: ${String(error)}`, "warn");
					}
					started();
					this.diagnostics.append(`Host ready: ${profile}${this.safeMode ? " (safe mode)" : ""}`);
				} catch (error) {
					started(error);
					throw error;
				}
			},
			stop: async () => {
				stopped = true;
				this.auth = void 0;
				const edgeStopped = this.diagnostics.operation("desktop", "lan.stop");
				try {
					await lan.stop();
					edgeStopped();
				} catch (error) {
					edgeStopped(error);
					throw error;
				}
				const hostStopped = this.diagnostics.operation("desktop", "host.stop");
				try {
					await host.stop();
					hostStopped();
				} catch (error) {
					hostStopped(error);
					throw error;
				}
				if (this.hostProcess === host) this.hostProcess = void 0;
				if (this.lan === lan) this.lan = void 0;
			}
		};
	}
};
//#endregion
export { NextDesktopRuntime as t };
