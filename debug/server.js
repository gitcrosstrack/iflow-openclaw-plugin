"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// debug/server.ts
var http = __toESM(require("http"));
var url = __toESM(require("url"));

// src/session-manager.ts
var import_child_process = require("child_process");

// src/session.ts
var import_iflow_cli_sdk = require("@iflow-ai/iflow-cli-sdk");

// src/shared.ts
var _sessionManager = null;
var _notificationRouter = null;
var pluginConfig = {
  maxSessions: 5,
  idleTimeoutMinutes: 30,
  maxPersistedSessions: 50,
  maxAutoResponds: 10,
  iflowTimeout: 3e5,
  skipSafetyChecks: false
};
function setSessionManager(sm2) {
  _sessionManager = sm2;
}
function setNotificationRouter(nr2) {
  _notificationRouter = nr2;
}
function setPluginConfig(config) {
  if (typeof config.maxSessions === "number") pluginConfig.maxSessions = config.maxSessions;
  if (typeof config.idleTimeoutMinutes === "number") pluginConfig.idleTimeoutMinutes = config.idleTimeoutMinutes;
  if (typeof config.maxPersistedSessions === "number") pluginConfig.maxPersistedSessions = config.maxPersistedSessions;
  if (typeof config.maxAutoResponds === "number") pluginConfig.maxAutoResponds = config.maxAutoResponds;
  if (typeof config.iflowTimeout === "number") pluginConfig.iflowTimeout = config.iflowTimeout;
  if (typeof config.fallbackChannel === "string") pluginConfig.fallbackChannel = config.fallbackChannel;
  if (typeof config.defaultWorkdir === "string") pluginConfig.defaultWorkdir = config.defaultWorkdir;
  if (typeof config.permissionMode === "string") pluginConfig.permissionMode = config.permissionMode;
  if (typeof config.skipSafetyChecks === "boolean") pluginConfig.skipSafetyChecks = config.skipSafetyChecks;
  if (config.agentChannels && typeof config.agentChannels === "object") {
    pluginConfig.agentChannels = config.agentChannels;
  }
}
var sessionManager = new Proxy({}, {
  get(_target, prop) {
    if (!_sessionManager) throw new Error("SessionManager not initialized");
    return _sessionManager[prop];
  }
});
var notificationRouter = new Proxy({}, {
  get(_target, prop) {
    if (!_notificationRouter) throw new Error("NotificationRouter not initialized");
    return _notificationRouter[prop];
  }
});
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function generateSessionName(prompt) {
  return prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().split(/\s+/).slice(0, 4).join("-").replace(/-+/g, "-").slice(0, 32) || "iflow-session";
}

// src/session.ts
var import_nanoid = require("nanoid");
var OUTPUT_BUFFER_MAX = 200;
var Session = class {
  constructor(config, name) {
    // State
    this.status = "starting";
    this.turnCount = 0;
    // Output
    this.outputBuffer = [];
    // Foreground channels
    this.foregroundChannels = /* @__PURE__ */ new Set();
    // Per-channel output offset for catchup
    this.fgOutputOffsets = /* @__PURE__ */ new Map();
    // Flags
    this.waitingForInputFired = false;
    // Auto-respond safety cap
    this.autoRespondCount = 0;
    this.id = (0, import_nanoid.nanoid)(8);
    this.name = name ?? generateSessionName(config.prompt);
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = config.model;
    this.timeout = config.timeout ?? pluginConfig.iflowTimeout ?? 3e5;
    this.maxTurns = config.maxTurns;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode ?? "auto";
    this.originChannel = config.originChannel;
    this.originAgentId = config.originAgentId;
    this.multiTurn = config.multiTurn ?? true;
    this.startedAt = Date.now();
    const options = {
      cwd: this.workdir,
      timeout: this.timeout,
      autoStartProcess: true,
      permissionMode: this.permissionMode,
      ...this.allowedTools ? { autoApproveTypes: this.allowedTools } : {},
      ...this.systemPrompt ? {
        sessionSettings: {
          system_prompt: this.systemPrompt,
          ...this.maxTurns ? { max_turns: this.maxTurns } : {}
        }
      } : this.maxTurns ? { sessionSettings: { max_turns: this.maxTurns } } : {}
    };
    this.client = new import_iflow_cli_sdk.IFlowClient(options);
  }
  async start() {
    try {
      await this.client.connect();
      await this.client.sendMessage(this.prompt);
      this.status = "running";
      this.resetIdleTimer();
      this.consumeMessages().catch((err) => {
        if (this.status === "starting" || this.status === "running") {
          this.status = "failed";
          this.error = err?.message ?? String(err);
          this.completedAt = Date.now();
          this.clearTimers();
          if (this.onComplete) this.onComplete(this);
        }
      });
    } catch (err) {
      this.status = "failed";
      this.error = err?.message ?? String(err);
      this.completedAt = Date.now();
      try {
        await this.client.disconnect();
      } catch {
      }
    }
  }
  /**
   * Send a follow-up message to a running multi-turn session.
   */
  async sendMessage(text) {
    if (this.status !== "running") {
      throw new Error(`Session is not running (status: ${this.status})`);
    }
    this.resetIdleTimer();
    this.waitingForInputFired = false;
    await this.client.sendMessage(text);
  }
  /**
   * Terminate the session.
   */
  kill() {
    if (this.status !== "starting" && this.status !== "running") return;
    this.clearTimers();
    this.status = "killed";
    this.completedAt = Date.now();
    this.client.disconnect().catch(() => {
    });
  }
  // ─── Output management ────────────────────────────────────────────────────
  getOutput(lines) {
    if (lines === void 0) return this.outputBuffer.slice();
    return this.outputBuffer.slice(-lines);
  }
  getCatchupOutput(channelId) {
    const lastOffset = this.fgOutputOffsets.get(channelId) ?? 0;
    const available = this.outputBuffer.length;
    if (lastOffset >= available) return [];
    return this.outputBuffer.slice(lastOffset);
  }
  markFgOutputSeen(channelId) {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }
  saveFgOutputOffset(channelId) {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }
  // ─── Auto-respond counter ─────────────────────────────────────────────────
  incrementAutoRespond() {
    this.autoRespondCount++;
  }
  resetAutoRespond() {
    this.autoRespondCount = 0;
  }
  // ─── Duration ─────────────────────────────────────────────────────────────
  get duration() {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }
  // ─── Private: message consumption ────────────────────────────────────────
  async consumeMessages() {
    for await (const msg of this.client.receiveMessages()) {
      this.resetSafetyNetTimer();
      if (msg.type === import_iflow_cli_sdk.MessageType.ASSISTANT) {
        this.waitingForInputFired = false;
        const text = msg.chunk?.text;
        if (text) {
          this.appendOutput(text);
          if (this.onOutput) {
            console.log(`[Session] ${this.id} calling onOutput, textLen=${text.length}`);
            this.onOutput(text);
          }
        }
      } else if (msg.type === import_iflow_cli_sdk.MessageType.TOOL_CALL) {
        const toolName = msg.toolName ?? "unknown_tool";
        const status = msg.status ?? "unknown";
        console.log(`[Session] ${this.id} tool_call: ${toolName} (${status})`);
        if (this.onToolUse) {
          this.onToolUse(toolName, status);
        }
      } else if (msg.type === import_iflow_cli_sdk.MessageType.PLAN) {
        if (msg.entries && Array.isArray(msg.entries)) {
          const planLines = msg.entries.map((e) => {
            const icon = e.status === "completed" ? "\u2705" : "\u23F3";
            return `${icon} [${e.priority ?? "-"}] ${e.content}`;
          });
          const planText = "\u{1F4CB} Plan:\n" + planLines.join("\n");
          this.appendOutput(planText);
          if (this.onOutput) this.onOutput(planText);
        }
      } else if (msg.type === import_iflow_cli_sdk.MessageType.TASK_FINISH) {
        this.clearSafetyNetTimer();
        this.turnCount++;
        const stopReason = msg.stopReason;
        if (this.multiTurn && stopReason === import_iflow_cli_sdk.StopReason.END_TURN) {
          console.log(`[Session] ${this.id} multi-turn end-of-turn (turn ${this.turnCount}), staying open`);
          this.resetIdleTimer();
          if (this.onWaitingForInput && !this.waitingForInputFired) {
            console.log(`[Session] ${this.id} calling onWaitingForInput`);
            this.waitingForInputFired = true;
            this.onWaitingForInput(this);
          }
        } else {
          this.clearTimers();
          if (stopReason === import_iflow_cli_sdk.StopReason.END_TURN || stopReason === import_iflow_cli_sdk.StopReason.MAX_TOKENS) {
            this.status = "completed";
          } else {
            this.status = "failed";
            this.error = `Stopped: ${stopReason ?? "unknown"}`;
          }
          this.completedAt = Date.now();
          console.log(`[Session] ${this.id} calling onComplete, status=${this.status}`);
          if (this.onComplete) this.onComplete(this);
          break;
        }
      } else if (msg.type === "error" || msg.code) {
        this.clearTimers();
        this.status = "failed";
        this.error = msg.message ?? `iFlow error code: ${msg.code}`;
        this.completedAt = Date.now();
        console.log(`[Session] ${this.id} error received: ${this.error}`);
        if (this.onComplete) this.onComplete(this);
        break;
      }
    }
    if (this.status === "running" || this.status === "starting") {
      this.clearTimers();
      this.status = "completed";
      this.completedAt = Date.now();
      if (this.onComplete) this.onComplete(this);
    }
  }
  appendOutput(text) {
    this.outputBuffer.push(text);
    if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_BUFFER_MAX);
    }
  }
  // ─── Timers ───────────────────────────────────────────────────────────────
  resetSafetyNetTimer() {
    this.clearSafetyNetTimer();
    const idleMs = (pluginConfig.safetyNetIdleSeconds ?? 600) * 1e3;
    this.safetyNetTimer = setTimeout(() => {
      this.safetyNetTimer = void 0;
      if (this.status === "running" && this.onWaitingForInput && !this.waitingForInputFired) {
        console.log(`[Session] ${this.id} no messages for ${idleMs / 1e3}s \u2014 firing onWaitingForInput (safety-net)`);
        this.waitingForInputFired = true;
        this.onWaitingForInput(this);
      }
    }, idleMs);
  }
  clearSafetyNetTimer() {
    if (this.safetyNetTimer) {
      clearTimeout(this.safetyNetTimer);
      this.safetyNetTimer = void 0;
    }
  }
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 30) * 60 * 1e3;
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") {
        console.log(`[Session] ${this.id} idle timeout reached (${pluginConfig.idleTimeoutMinutes ?? 30}min), auto-killing`);
        this.kill();
      }
    }, idleTimeoutMs);
  }
  clearTimers() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = void 0;
    }
    this.clearSafetyNetTimer();
  }
};

// src/session-manager.ts
var CLEANUP_MAX_AGE_MS = 60 * 60 * 1e3;
var WAKE_CLI_TIMEOUT_MS = 1e4;
var WAKE_RETRY_DELAY_MS = 5e3;
var WAITING_EVENT_DEBOUNCE_MS = 5e3;
var SessionManager = class {
  constructor(maxSessions = 5, maxPersistedSessions = 50) {
    this.sessions = /* @__PURE__ */ new Map();
    this.persistedSessions = /* @__PURE__ */ new Map();
    this.pendingRetryTimers = /* @__PURE__ */ new Set();
    this.lastWaitingEventTimestamps = /* @__PURE__ */ new Map();
    this.notificationRouter = null;
    this._metrics = {
      totalSessions: 0,
      sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
      totalDurationMs: 0,
      sessionsWithDuration: 0
    };
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
  }
  // ─── Session lifecycle ────────────────────────────────────────────────────
  spawn(config) {
    const active = this.list("running").length + this.list("starting").length;
    if (active >= this.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions reached (${this.maxSessions}). Kill a session first.`
      );
    }
    const name = config.name ?? generateSessionName(config.prompt);
    const session = new Session(config, name);
    this.sessions.set(session.id, session);
    this._metrics.totalSessions++;
    const nr2 = this.notificationRouter;
    if (nr2) {
      session.onOutput = (text) => {
        console.log(`[SessionManager] session.onOutput fired for session=${session.id}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
        nr2.onAssistantText(session, text);
        for (const ch of session.foregroundChannels) {
          session.markFgOutputSeen(ch);
        }
      };
      session.onToolUse = (toolName, status) => {
        console.log(`[SessionManager] session.onToolUse fired for session=${session.id}, tool=${toolName}, status=${status}`);
        nr2.onToolUse(session, toolName, status);
      };
      session.onWaitingForInput = () => {
        console.log(`[SessionManager] session.onWaitingForInput fired for session=${session.id}`);
        nr2.onWaitingForInput(session);
        this.triggerWaitingForInputEvent(session);
      };
      session.onComplete = () => {
        console.log(`[SessionManager] session.onComplete fired for session=${session.id}, status=${session.status}`);
        this.persistSession(session);
        nr2.onSessionComplete(session);
        this.triggerAgentEvent(session);
      };
    } else {
      console.warn(`[SessionManager] No NotificationRouter available when spawning session=${session.id}`);
    }
    session.start().catch((err) => {
      console.error(`[SessionManager] session.start() threw for session=${session.id}: ${err?.message}`);
    });
    const promptSummary = session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt;
    this.deliverToTelegram(session, `\u21A9\uFE0F [${session.name}] Launched:
${promptSummary}`, "launched");
    return session;
  }
  // ─── Persistence ──────────────────────────────────────────────────────────
  persistSession(session) {
    const alreadyPersisted = this.persistedSessions.has(session.id);
    if (!alreadyPersisted) {
      this.recordSessionMetrics(session);
    }
    const info = {
      sessionId: session.id,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      completedAt: session.completedAt,
      status: session.status,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel
    };
    this.persistedSessions.set(session.id, info);
    this.persistedSessions.set(session.name, info);
    console.log(`[SessionManager] Persisted session ${session.name} [${session.id}]`);
  }
  getPersistedSession(ref) {
    return this.persistedSessions.get(ref);
  }
  listPersistedSessions() {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const info of this.persistedSessions.values()) {
      if (!seen.has(info.sessionId)) {
        seen.add(info.sessionId);
        result.push(info);
      }
    }
    return result.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }
  // ─── Metrics ──────────────────────────────────────────────────────────────
  recordSessionMetrics(session) {
    const status = session.status;
    if (status === "completed" || status === "failed" || status === "killed") {
      this._metrics.sessionsByStatus[status]++;
    }
    if (session.completedAt) {
      const durationMs = session.completedAt - session.startedAt;
      this._metrics.totalDurationMs += durationMs;
      this._metrics.sessionsWithDuration++;
    }
    if (!this._metrics.mostExpensive) {
      this._metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        prompt: session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt
      };
    }
  }
  getMetrics() {
    return { ...this._metrics };
  }
  // ─── Query ────────────────────────────────────────────────────────────────
  resolve(idOrName) {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;
    for (const session of this.sessions.values()) {
      if (session.name === idOrName) return session;
    }
    return void 0;
  }
  get(id) {
    return this.sessions.get(id);
  }
  list(filter) {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }
  // ─── Kill ─────────────────────────────────────────────────────────────────
  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    if (!this.persistedSessions.has(session.id)) {
      this.recordSessionMetrics(session);
    }
    this.persistSession(session);
    if (this.notificationRouter) {
      this.notificationRouter.onSessionComplete(session);
    }
    this.triggerAgentEvent(session);
    return true;
  }
  killAll() {
    for (const session of this.sessions.values()) {
      if (session.status === "starting" || session.status === "running") {
        this.kill(session.id);
      }
    }
    for (const timer of this.pendingRetryTimers) {
      clearTimeout(timer);
    }
    this.pendingRetryTimers.clear();
  }
  // ─── GC ───────────────────────────────────────────────────────────────────
  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.completedAt && (session.status === "completed" || session.status === "failed" || session.status === "killed") && now - session.completedAt > CLEANUP_MAX_AGE_MS) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
      }
    }
    const unique = this.listPersistedSessions();
    if (unique.length > this.maxPersistedSessions) {
      const toEvict = unique.slice(this.maxPersistedSessions);
      for (const info of toEvict) {
        for (const [key, val] of this.persistedSessions) {
          if (val.sessionId === info.sessionId) {
            this.persistedSessions.delete(key);
          }
        }
      }
      console.log(`[SessionManager] Evicted ${toEvict.length} oldest persisted sessions (cap=${this.maxPersistedSessions})`);
    }
  }
  // ─── Notifications & IPC wake ─────────────────────────────────────────────
  /**
   * Parse originChannel into --deliver CLI args for openclaw agent wakeup.
   */
  buildDeliverArgs(originChannel) {
    if (!originChannel || originChannel === "unknown" || originChannel === "gateway") {
      return [];
    }
    const parts = originChannel.split("|");
    if (parts.length < 2) return [];
    if (parts.length >= 3) {
      return ["--deliver", "--reply-channel", parts[0], "--reply-account", parts[1], "--reply-to", parts.slice(2).join("|")];
    }
    return ["--deliver", "--reply-channel", parts[0], "--reply-to", parts[1]];
  }
  /**
   * Send Telegram notification AND wake the agent via detached subprocess.
   * Used for events that require agent reaction (completed, waiting for input).
   */
  wakeAgent(session, eventText, telegramText, label) {
    this.deliverToTelegram(session, telegramText, label);
    const agentId = session.originAgentId?.trim();
    if (!agentId) {
      console.warn(`[SessionManager] No originAgentId for ${label} session=${session.id}, falling back to system event`);
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }
    const deliverArgs = this.buildDeliverArgs(session.originChannel);
    const child = (0, import_child_process.spawn)("openclaw", ["agent", "--agent", agentId, "--message", eventText, ...deliverArgs], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    console.log(`[SessionManager] Spawned detached wake for agent=${agentId}, ${label} session=${session.id} (pid=${child.pid})`);
  }
  /**
   * Send an informational notification to Telegram WITHOUT waking the agent.
   * Used for: ↩️ Launched, ↩️ Responded, ❌ Failed, ⛔ Killed.
   */
  deliverToTelegram(session, notificationText, label) {
    if (!this.notificationRouter) {
      console.warn(`[SessionManager] Cannot deliver ${label} to Telegram for session=${session.id} (no NotificationRouter)`);
      return;
    }
    const channel = session.originChannel || "unknown";
    console.log(`[SessionManager] Delivering ${label} to Telegram for session=${session.id} via channel=${channel}`);
    this.notificationRouter.emitToChannel(channel, notificationText);
  }
  fireSystemEventWithRetry(eventText, label, sessionId) {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    (0, import_child_process.execFile)("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[SessionManager] System event failed for ${label} session=${sessionId}: ${err.message}`);
        if (stderr) console.error(`[SessionManager] stderr: ${stderr}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          (0, import_child_process.execFile)("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr, _retryStdout, retryStderr) => {
            if (retryErr) {
              console.error(`[SessionManager] System event retry also failed for ${label} session=${sessionId}: ${retryErr.message}`);
              if (retryStderr) console.error(`[SessionManager] retry stderr: ${retryStderr}`);
            } else {
              console.log(`[SessionManager] System event retry succeeded for ${label} session=${sessionId}`);
            }
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      } else {
        console.log(`[SessionManager] System event sent for ${label} session=${sessionId}`);
      }
    });
  }
  /**
   * Trigger agent event when a session completes or fails/is killed.
   */
  triggerAgentEvent(session) {
    const status = session.status;
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) preview = preview.slice(-500);
    if (status === "completed") {
      const eventText = [
        `iFlow session completed.`,
        `Name: ${session.name} | ID: ${session.id}`,
        `Status: ${status}`,
        ``,
        `Output preview:`,
        preview,
        ``,
        `Use iflow_output(session='${session.id}', full=true) to get the full result.`
      ].join("\n");
      const cleanPreview = preview.replace(/[*`_~]/g, "");
      const telegramLines = [
        `\u2705 [${session.name}] Completed`,
        `   \u{1F4C1} ${session.workdir}`,
        `   \u23F1\uFE0F ${formatDuration(session.duration)}`
      ];
      if (cleanPreview.trim()) telegramLines.push(``, cleanPreview);
      const telegramText = telegramLines.join("\n");
      console.log(`[SessionManager] Triggering agent wake for completed session=${session.id}`);
      this.wakeAgent(session, eventText, telegramText, "completed");
    } else {
      const emoji = status === "killed" ? "\u26D4" : "\u274C";
      const promptSummary = session.prompt.length > 60 ? session.prompt.slice(0, 60) + "..." : session.prompt;
      const notificationText = [
        `${emoji} [${session.name}] ${status === "killed" ? "Killed" : "Failed"}`,
        `   \u{1F4C1} ${session.workdir}`,
        `   \u{1F4DD} "${promptSummary}"`,
        ...session.error ? [`   \u26A0\uFE0F ${session.error}`] : []
      ].join("\n");
      console.log(`[SessionManager] Delivering ${status} notification for session=${session.id}`);
      this.deliverToTelegram(session, notificationText, status);
    }
    this.lastWaitingEventTimestamps.delete(session.id);
  }
  /**
   * Trigger event when a session is waiting for user input.
   * Telegram notification is unconditional; IPC wake is debounced (5s).
   */
  triggerWaitingForInputEvent(session) {
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) preview = preview.slice(-500);
    const telegramText = `\u{1F514} [${session.name}] iFlow asks:
${preview.length > 200 ? preview.slice(-200) : preview}`;
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(session.id);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) {
      console.log(`[SessionManager] Debounced wake for session=${session.id} (last sent ${now - lastTs}ms ago), sending Telegram only`);
      this.deliverToTelegram(session, telegramText, "waiting");
      return;
    }
    this.lastWaitingEventTimestamps.set(session.id, now);
    const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
    const eventText = [
      `${sessionType} is waiting for input.`,
      `Name: ${session.name} | ID: ${session.id}`,
      ``,
      `Last output:`,
      preview,
      ``,
      `Use iflow_respond(session='${session.id}', message='...') to send a reply, or iflow_output(session='${session.id}') to see full context.`
    ].join("\n");
    this.wakeAgent(session, eventText, telegramText, "waiting");
  }
};

// src/notifications.ts
var DEBOUNCE_MS = 500;
var LONG_RUNNING_THRESHOLD_MS = 10 * 60 * 1e3;
var NotificationRouter = class {
  constructor(sendMessage) {
    this.debounceMap = /* @__PURE__ */ new Map();
    this.longRunningReminded = /* @__PURE__ */ new Set();
    this.reminderInterval = null;
    this.getActiveSessions = null;
    this.sendMessage = (channelId, text) => {
      console.log(`[NotificationRouter] sendMessage -> channel=${channelId}, textLen=${text.length}, preview=${text.slice(0, 120)}`);
      sendMessage(channelId, text);
    };
    console.log("[NotificationRouter] Initialized");
  }
  startReminderCheck(getActiveSessions) {
    this.getActiveSessions = getActiveSessions;
    this.reminderInterval = setInterval(() => this.checkLongRunning(), 6e4);
  }
  stop() {
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    for (const [key, entry] of this.debounceMap) {
      clearTimeout(entry.timer);
      if (entry.buffer) {
        const firstPipe = key.indexOf("|");
        const channelId = firstPipe >= 0 ? key.slice(firstPipe + 1) : key;
        this.sendMessage(channelId, entry.buffer);
      }
    }
    this.debounceMap.clear();
    this.longRunningReminded.clear();
  }
  // ─── Foreground streaming ─────────────────────────────────────────────────
  onAssistantText(session, text) {
    console.log(`[NotificationRouter] onAssistantText session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}, textLen=${text.length}`);
    if (session.foregroundChannels.size === 0) {
      console.log(`[NotificationRouter] onAssistantText SKIPPED \u2014 no foreground channels`);
      return;
    }
    for (const channelId of session.foregroundChannels) {
      console.log(`[NotificationRouter] appendDebounced -> session=${session.id}, channel=${channelId}`);
      this.appendDebounced(session.id, channelId, text);
    }
  }
  onToolUse(session, toolName, status) {
    console.log(`[NotificationRouter] onToolUse session=${session.id}, tool=${toolName}, status=${status}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    if (session.foregroundChannels.size === 0) return;
    if (status !== "start" && status !== "running" && status !== "unknown") return;
    const line = `\u{1F527} ${toolName}`;
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
      this.sendMessage(channelId, line);
    }
  }
  // ─── Completion notifications ─────────────────────────────────────────────
  onSessionComplete(session) {
    console.log(`[NotificationRouter] onSessionComplete session=${session.id} (${session.name}), status=${session.status}`);
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    const msg = formatCompletionNotification(session);
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }
    this.cleanupSession(session.id);
  }
  onLimitReached(session) {
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    const duration = formatDuration(session.duration);
    const msg = [
      `\u26D4 Session limit reached \u2014 ${session.name} [${session.id}] (${duration})`,
      `   \u{1F4C1} ${session.workdir}`
    ].join("\n");
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }
    this.cleanupSession(session.id);
  }
  // ─── Waiting for input ────────────────────────────────────────────────────
  onWaitingForInput(session) {
    console.log(`[NotificationRouter] onWaitingForInput session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    for (const channelId of session.foregroundChannels) {
      const duration = formatDuration(session.duration);
      const msg = [
        `\u{1F4AC} Session ${session.name} [${session.id}] is waiting for input (${duration})`,
        `   Use iflow_respond to reply.`
      ].join("\n");
      this.sendMessage(channelId, msg);
    }
  }
  // ─── Public passthrough ───────────────────────────────────────────────────
  emitToChannel(channelId, text) {
    this.sendMessage(channelId, text);
  }
  // ─── Long-running reminder ────────────────────────────────────────────────
  checkLongRunning() {
    if (!this.getActiveSessions) return;
    const sessions = this.getActiveSessions();
    const now = Date.now();
    for (const session of sessions) {
      if ((session.status === "running" || session.status === "starting") && session.foregroundChannels.size === 0 && !this.longRunningReminded.has(session.id) && now - session.startedAt > LONG_RUNNING_THRESHOLD_MS) {
        this.longRunningReminded.add(session.id);
        const duration = formatDuration(now - session.startedAt);
        const msg = [
          `\u23F1\uFE0F Session ${session.name} [${session.id}] running for ${duration}`,
          `   \u{1F4C1} ${session.workdir}`,
          `   Use iflow_fg to check on it, or iflow_kill to stop it.`
        ].join("\n");
        if (session.originChannel) {
          this.sendMessage(session.originChannel, msg);
        }
      }
    }
  }
  // ─── Debounce internals ───────────────────────────────────────────────────
  debounceKey(sessionId, channelId) {
    return `${sessionId}|${channelId}`;
  }
  appendDebounced(sessionId, channelId, text) {
    const key = this.debounceKey(sessionId, channelId);
    const existing = this.debounceMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.buffer += text;
      existing.timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
      this.debounceMap.set(key, { buffer: text, timer });
    }
  }
  flushDebounced(sessionId, channelId) {
    const key = this.debounceKey(sessionId, channelId);
    const entry = this.debounceMap.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.buffer) {
      console.log(`[NotificationRouter] flushDebounced -> session=${sessionId}, channel=${channelId}, bufferLen=${entry.buffer.length}`);
      this.sendMessage(channelId, entry.buffer);
    }
    this.debounceMap.delete(key);
  }
  cleanupSession(sessionId) {
    for (const key of this.debounceMap.keys()) {
      if (key.startsWith(`${sessionId}|`)) {
        const entry = this.debounceMap.get(key);
        clearTimeout(entry.timer);
        this.debounceMap.delete(key);
      }
    }
    this.longRunningReminded.delete(sessionId);
  }
};
function formatCompletionNotification(session) {
  const duration = formatDuration(session.duration);
  const promptSummary = session.prompt.length > 60 ? session.prompt.slice(0, 60) + "..." : session.prompt;
  if (session.status === "completed") {
    return [
      `\u2705 iFlow [${session.id}] completed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`
    ].join("\n");
  }
  if (session.status === "failed") {
    const errorDetail = session.error ? `   \u26A0\uFE0F ${session.error}` : "";
    return [
      `\u274C iFlow [${session.id}] failed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`,
      ...errorDetail ? [errorDetail] : []
    ].join("\n");
  }
  if (session.status === "killed") {
    return [
      `\u26D4 iFlow [${session.id}] killed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`
    ].join("\n");
  }
  return `Session [${session.id}] finished with status: ${session.status}`;
}

// debug/server.ts
setPluginConfig({
  maxSessions: 10,
  permissionMode: "auto",
  iflowTimeout: 3e5,
  idleTimeoutMinutes: 30,
  maxAutoResponds: 10
});
var sseClients = /* @__PURE__ */ new Set();
function sseEmit(event) {
  const data = `data: ${JSON.stringify(event)}

`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
    }
  }
}
var nr = new NotificationRouter((channelId, text) => {
  console.log(`[Notification] channel=${channelId} text=${text.slice(0, 80)}`);
});
setNotificationRouter(nr);
var sm = new SessionManager(10, 50);
sm.notificationRouter = nr;
setSessionManager(sm);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}
function formatDur(ms) {
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
function snap(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    prompt: s.prompt,
    workdir: s.workdir,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    duration: formatDur(s.duration),
    turnCount: s.turnCount,
    error: s.error
  };
}
var HTML_PARTS = [
  `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"/>`,
  `<meta name="viewport" content="width=device-width,initial-scale=1"/>`,
  `<title>iFlow Debug</title><style>`,
  `*{box-sizing:border-box;margin:0;padding:0}`,
  `body{font-family:monospace;background:#0d1117;color:#c9d1d9;height:100vh;display:flex;flex-direction:column}`,
  `header{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:12px}`,
  `header h1{font-size:16px;color:#58a6ff}`,
  `.badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e}`,
  `.main{display:flex;flex:1;overflow:hidden}`,
  `.panel{display:flex;flex-direction:column;border-right:1px solid #30363d}`,
  `.panel-left{width:320px;min-width:280px}.panel-mid{width:300px;min-width:240px}.panel-right{flex:1}`,
  `.panel-title{padding:10px 14px;font-size:12px;color:#8b949e;background:#161b22;border-bottom:1px solid #30363d;text-transform:uppercase;letter-spacing:.5px}`,
  `.panel-body{flex:1;overflow-y:auto;padding:14px}`,
  `.form-group{margin-bottom:12px}`,
  `label{display:block;font-size:11px;color:#8b949e;margin-bottom:4px}`,
  `input,textarea{width:100%;background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:7px 10px;border-radius:6px;font-family:monospace;font-size:13px;outline:none}`,
  `input:focus,textarea:focus{border-color:#58a6ff}`,
  `textarea{resize:vertical;min-height:80px}`,
  `.toggle-row{display:flex;align-items:center;gap:8px;font-size:13px}`,
  `input[type=checkbox]{width:auto}`,
  `button{width:100%;padding:8px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:monospace;margin-top:4px}`,
  `button:hover{background:#2ea043}`,
  `button.danger{background:#da3633}button.danger:hover{background:#f85149}`,
  `button.secondary{background:#21262d;color:#c9d1d9;border:1px solid #30363d}button.secondary:hover{background:#30363d}`,
  `.session-item{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}`,
  `.session-item:hover,.session-item.active{border-color:#58a6ff}`,
  `.session-header{display:flex;align-items:center;gap:6px;margin-bottom:4px}`,
  `.session-name{font-size:13px;font-weight:bold;color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
  `.status-badge{font-size:10px;padding:1px 6px;border-radius:8px;white-space:nowrap}`,
  `.status-running{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb}`,
  `.status-starting{background:#9e6a0333;color:#d29922;border:1px solid #9e6a03}`,
  `.status-completed{background:#1a7f3733;color:#3fb950;border:1px solid #1a7f37}`,
  `.status-failed{background:#da363333;color:#f85149;border:1px solid #da3633}`,
  `.status-killed{background:#6e768133;color:#8b949e;border:1px solid #6e7681}`,
  `.session-meta{font-size:11px;color:#8b949e}`,
  `.session-actions{display:flex;gap:6px;margin-top:8px}`,
  `.session-actions button{margin-top:0;padding:4px 8px;font-size:11px;width:auto}`,
  `.output-tabs{display:flex;border-bottom:1px solid #30363d;background:#161b22;overflow-x:auto}`,
  `.tab{padding:8px 14px;font-size:12px;cursor:pointer;color:#8b949e;border-bottom:2px solid transparent;white-space:nowrap}`,
  `.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}`,
  `.output-area{flex:1;overflow-y:auto;padding:14px;font-size:12px;line-height:1.6}`,
  `.output-area pre{white-space:pre-wrap;word-break:break-word}`,
  `.event-output{color:#c9d1d9}.event-tool{color:#d29922}.event-waiting{color:#58a6ff;font-weight:bold}`,
  `.event-complete{color:#3fb950;font-weight:bold}.event-error{color:#f85149}.event-system{color:#8b949e;font-style:italic}`,
  `.respond-bar{padding:10px 14px;border-top:1px solid #30363d;display:flex;gap:8px}`,
  `.respond-bar input{flex:1}.respond-bar button{width:auto;margin-top:0;padding:7px 14px}`,
  `.empty{color:#8b949e;font-size:12px;text-align:center;padding:40px 0}`,
  `</style></head><body>`,
  `<header><h1>&#9889; iFlow Debug</h1>`,
  `<span class="badge" id="active-count">0 active</span>`,
  `<span class="badge" id="total-count">0 total</span></header>`,
  `<div class="main">`,
  `<div class="panel panel-left">`,
  `<div class="panel-title">Launch Session</div>`,
  `<div class="panel-body">`,
  `<div class="form-group"><label>Prompt *</label><textarea id="prompt" placeholder="e.g. \u8BA1\u7B97 1+1"></textarea></div>`,
  `<div class="form-group"><label>Working Directory</label><input id="workdir" placeholder="/Users/zdq/.openclaw/workspace"/></div>`,
  `<div class="form-group"><label>Session Name (optional)</label><input id="name" placeholder="auto-generated"/></div>`,
  `<div class="form-group"><div class="toggle-row"><input type="checkbox" id="multiTurn" checked/>`,
  `<label for="multiTurn" style="margin:0">Multi-turn</label></div></div>`,
  `<button id="btn-launch">&#9654; Launch</button>`,
  `<div id="launch-error" style="color:#f85149;font-size:12px;margin-top:8px"></div>`,
  `</div></div>`,
  `<div class="panel panel-mid"><div class="panel-title">Sessions</div>`,
  `<div class="panel-body" id="session-list"><div class="empty">No sessions yet</div></div></div>`,
  `<div class="panel panel-right" style="border-right:none">`,
  `<div class="output-tabs" id="output-tabs"></div>`,
  `<div class="output-area" id="output-area"><div class="empty">Select a session to view output</div></div>`,
  `<div class="respond-bar"><input id="respond-input" placeholder="Send follow-up message..."/>`,
  `<button id="btn-respond">Send</button></div>`,
  `</div></div>`,
  `<script>`,
  `var outputs={},activeTab=null,selectedSession=null;`,
  `function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}`,
  `function connectSSE(){`,
  `  var es=new EventSource("/api/events");`,
  `  es.onmessage=function(e){handleEvent(JSON.parse(e.data));};`,
  `  es.onerror=function(){setTimeout(connectSSE,2000);};`,
  `}`,
  `function handleEvent(ev){`,
  `  var sid=ev.sessionId;`,
  `  if(!outputs[sid])outputs[sid]=[];`,
  `  if(ev.type==="output")outputs[sid].push({type:"output",text:ev.text});`,
  `  else if(ev.type==="tool")outputs[sid].push({type:"tool",text:"Tool: "+ev.toolName+" ("+ev.status+")"});`,
  `  else if(ev.type==="waiting")outputs[sid].push({type:"waiting",text:"Waiting for input \u2014 use Respond below"});`,
  `  else if(ev.type==="complete")outputs[sid].push({type:"complete",text:"Completed (status: "+ev.status+")"});`,
  `  else if(ev.type==="error")outputs[sid].push({type:"error",text:"Error: "+ev.error});`,
  `  if(activeTab===sid)renderOutput(sid);`,
  `  if(activeTab)renderTabs(activeTab);`,
  `  refreshSessions();`,
  `}`,
  `function refreshSessions(){`,
  `  fetch("/api/sessions").then(function(r){return r.json();}).then(function(sessions){`,
  `    var active=sessions.filter(function(s){return s.status==="running"||s.status==="starting";}).length;`,
  `    document.getElementById("active-count").textContent=active+" active";`,
  `    document.getElementById("total-count").textContent=sessions.length+" total";`,
  `    var list=document.getElementById("session-list");`,
  `    if(!sessions.length){list.innerHTML='<div class="empty">No sessions yet</div>';return;}`,
  `    list.innerHTML="";`,
  `    sessions.forEach(function(s){`,
  `      var item=document.createElement("div");`,
  `      item.className="session-item"+(selectedSession===s.id?" active":"");`,
  `      var ps=s.prompt.length>50?s.prompt.slice(0,50)+"...":s.prompt;`,
  `      var errHtml=s.error?'<div class="session-meta" style="color:#f85149">'+esc(s.error)+"</div>":"";`,
  `      item.innerHTML=`,
  `        '<div class="session-header">'+`,
  `        '<span class="session-name">'+esc(s.name)+"</span>"+`,
  `        '<span class="status-badge status-'+s.status+'">'+s.status+"</span></div>"+`,
  `        '<div class="session-meta">['+s.id+"] "+s.duration+" "+s.turnCount+" turns</div>"+`,
  `        '<div class="session-meta">'+esc(ps)+"</div>"+`,
  `        errHtml+`,
  `        '<div class="session-actions">'+`,
  `        '<button class="secondary btn-out" data-id="'+s.id+'">Output</button>'+`,
  `        ((s.status==="running"||s.status==="starting")?'<button class="danger btn-kill" data-id="'+s.id+'">Kill</button>':"")+`,
  `        "</div>";`,
  `      item.addEventListener("click",function(){selectSession(s.id);});`,
  `      list.appendChild(item);`,
  `    });`,
  `    list.querySelectorAll(".btn-kill").forEach(function(b){`,
  `      b.addEventListener("click",function(e){e.stopPropagation();killSession(b.dataset.id);});`,
  `    });`,
  `    list.querySelectorAll(".btn-out").forEach(function(b){`,
  `      b.addEventListener("click",function(e){e.stopPropagation();selectSession(b.dataset.id);});`,
  `    });`,
  `  });`,
  `}`,
  `function selectSession(id){`,
  `  selectedSession=id;`,
  `  if(!outputs[id])outputs[id]=[];`,
  `  renderTabs(id);`,
  `  refreshSessions();`,
  `}`,
  `function renderTabs(sid){`,
  `  activeTab=sid;`,
  `  var el=document.getElementById("output-tabs");`,
  `  var ids=Object.keys(outputs);`,
  `  if(ids.indexOf(sid)<0)ids.push(sid);`,
  `  el.innerHTML="";`,
  `  ids.forEach(function(id){`,
  `    var t=document.createElement("div");`,
  `    t.className="tab"+(id===activeTab?" active":"");`,
  `    t.textContent=id;`,
  `    t.addEventListener("click",function(){renderTabs(id);});`,
  `    el.appendChild(t);`,
  `  });`,
  `  renderOutput(sid);`,
  `}`,
  `function renderOutput(sid){`,
  `  var area=document.getElementById("output-area");`,
  `  var evs=outputs[sid]||[];`,
  `  if(!evs.length){area.innerHTML='<div class="empty">No output yet</div>';return;}`,
  `  area.innerHTML=evs.map(function(ev){return'<pre class="event-'+ev.type+'">'+esc(ev.text)+"</pre>";}).join("");`,
  `  area.scrollTop=area.scrollHeight;`,
  `}`,
  `function launchSession(){`,
  `  var prompt=document.getElementById("prompt").value.trim();`,
  `  var workdir=document.getElementById("workdir").value.trim();`,
  `  var name=document.getElementById("name").value.trim();`,
  `  var multiTurn=document.getElementById("multiTurn").checked;`,
  `  var errEl=document.getElementById("launch-error");`,
  `  if(!prompt){errEl.textContent="Prompt is required";return;}`,
  `  errEl.textContent="";`,
  `  fetch("/api/launch",{method:"POST",headers:{"Content-Type":"application/json"},`,
  `    body:JSON.stringify({prompt:prompt,workdir:workdir||undefined,name:name||undefined,multiTurn:multiTurn})`,
  `  }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})`,
  `  .then(function(res){`,
  `    if(!res.ok){errEl.textContent=res.data.error||"Launch failed";return;}`,
  `    outputs[res.data.id]=[];`,
  `    selectSession(res.data.id);`,
  `    document.getElementById("prompt").value="";`,
  `    document.getElementById("name").value="";`,
  `    refreshSessions();`,
  `  });`,
  `}`,
  `function killSession(id){`,
  `  fetch("/api/kill",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session:id})})`,
  `  .then(function(){refreshSessions();});`,
  `}`,
  `function sendRespond(){`,
  `  var msg=document.getElementById("respond-input").value.trim();`,
  `  if(!msg||!selectedSession)return;`,
  `  fetch("/api/respond",{method:"POST",headers:{"Content-Type":"application/json"},`,
  `    body:JSON.stringify({session:selectedSession,message:msg})`,
  `  }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})`,
  `  .then(function(res){`,
  `    if(!outputs[selectedSession])outputs[selectedSession]=[];`,
  `    if(!res.ok){`,
  `      outputs[selectedSession].push({type:"error",text:"Respond error: "+(res.data.error||"unknown")});`,
  `    }else{`,
  `      document.getElementById("respond-input").value="";`,
  `      outputs[selectedSession].push({type:"system",text:"You: "+msg});`,
  `    }`,
  `    renderOutput(selectedSession);`,
  `  });`,
  `}`,
  `document.getElementById("btn-launch").addEventListener("click",launchSession);`,
  `document.getElementById("btn-respond").addEventListener("click",sendRespond);`,
  `document.getElementById("respond-input").addEventListener("keydown",function(e){if(e.key==="Enter")sendRespond();});`,
  `connectSSE();`,
  `setInterval(refreshSessions,3000);`,
  `refreshSessions();`,
  `</script></body></html>`
];
var HTML = HTML_PARTS.join("\n");
var PORT = 7777;
var server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = parsed.pathname || "/";
  const method = req.method || "GET";
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }
  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    json(res, sm.list("all").map(snap));
    return;
  }
  if (method === "GET" && pathname === "/api/stats") {
    const metrics = sm.getMetrics();
    json(res, { ...metrics, activeSessions: sm.list("running").length + sm.list("starting").length });
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/output/")) {
    const ref = decodeURIComponent(pathname.slice("/api/output/".length));
    const session = sm.resolve(ref);
    if (!session) {
      json(res, { error: `Session not found` }, 404);
      return;
    }
    json(res, { id: session.id, name: session.name, status: session.status, output: session.getOutput() });
    return;
  }
  if (method === "POST" && pathname === "/api/launch") {
    try {
      const body = await readBody(req);
      if (!body.prompt) {
        json(res, { error: "prompt is required" }, 400);
        return;
      }
      const session = sm.spawn({
        prompt: body.prompt,
        workdir: body.workdir || process.cwd(),
        name: body.name,
        multiTurn: body.multiTurn !== false,
        permissionMode: "auto"
      });
      session.onOutput = (text) => sseEmit({ type: "output", sessionId: session.id, text });
      session.onToolUse = (toolName, status) => sseEmit({ type: "tool", sessionId: session.id, toolName, status });
      session.onWaitingForInput = () => sseEmit({ type: "waiting", sessionId: session.id });
      session.onComplete = () => {
        sseEmit({ type: "complete", sessionId: session.id, status: session.status });
        if (session.error) sseEmit({ type: "error", sessionId: session.id, error: session.error });
      };
      json(res, snap(session), 201);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }
  if (method === "POST" && pathname === "/api/respond") {
    try {
      const body = await readBody(req);
      if (!body.session || !body.message) {
        json(res, { error: "session and message required" }, 400);
        return;
      }
      const session = sm.resolve(body.session);
      if (!session) {
        json(res, { error: "Session not found" }, 404);
        return;
      }
      if (session.status !== "running") {
        json(res, { error: `Session not running (${session.status})` }, 400);
        return;
      }
      await session.sendMessage(body.message);
      json(res, { success: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }
  if (method === "POST" && pathname === "/api/kill") {
    try {
      const body = await readBody(req);
      if (!body.session) {
        json(res, { error: "session required" }, 400);
        return;
      }
      const session = sm.resolve(body.session);
      if (!session) {
        json(res, { error: "Session not found" }, 404);
        return;
      }
      json(res, { success: sm.kill(session.id) });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }
  json(res, { error: "Not found" }, 404);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`
\u26A1 iFlow Debug Server running at http://127.0.0.1:${PORT}
`);
});
process.on("SIGINT", () => {
  sm.killAll();
  server.close();
  process.exit(0);
});
