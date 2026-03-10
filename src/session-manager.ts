import { spawn, execFile } from "child_process";
import { Session } from "./session";
import type { NotificationRouter } from "./notifications";
import type {
  SessionConfig,
  SessionStatus,
  SessionMetrics,
  PersistedSessionInfo,
} from "./types";
import { pluginConfig, resolveOriginChannel, resolveAgentChannel, generateSessionName, formatDuration } from "./shared";

const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const WAKE_CLI_TIMEOUT_MS = 10_000;
const WAKE_RETRY_DELAY_MS = 5_000;
const WAITING_EVENT_DEBOUNCE_MS = 5_000;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private persistedSessions: Map<string, PersistedSessionInfo> = new Map();
  private maxSessions: number;
  private maxPersistedSessions: number;
  private pendingRetryTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private lastWaitingEventTimestamps: Map<string, number> = new Map();

  notificationRouter: NotificationRouter | null = null;

  private _metrics: SessionMetrics = {
    totalSessions: 0,
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalDurationMs: 0,
    sessionsWithDuration: 0,
  };

  constructor(maxSessions: number = 5, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  spawn(config: SessionConfig): Session {
    // Check session limit
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

    const nr = this.notificationRouter;

    if (nr) {
      session.onOutput = (text: string) => {
        console.log(`[SessionManager] session.onOutput fired for session=${session.id}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
        nr.onAssistantText(session, text);
        for (const ch of session.foregroundChannels) {
          session.markFgOutputSeen(ch);
        }
      };

      session.onToolUse = (toolName: string, status: string) => {
        console.log(`[SessionManager] session.onToolUse fired for session=${session.id}, tool=${toolName}, status=${status}`);
        nr.onToolUse(session, toolName, status);
      };

      session.onWaitingForInput = () => {
        console.log(`[SessionManager] session.onWaitingForInput fired for session=${session.id}`);
        nr.onWaitingForInput(session);
        this.triggerWaitingForInputEvent(session);
      };

      session.onComplete = () => {
        console.log(`[SessionManager] session.onComplete fired for session=${session.id}, status=${session.status}`);
        this.persistSession(session);
        nr.onSessionComplete(session);
        this.triggerAgentEvent(session);
      };
    } else {
      console.warn(`[SessionManager] No NotificationRouter available when spawning session=${session.id}`);
    }

    session.start().catch((err) => {
      console.error(`[SessionManager] session.start() threw for session=${session.id}: ${err?.message}`);
    });

    // Send ↩️ Launched notification
    const promptSummary = session.prompt.length > 80
      ? session.prompt.slice(0, 80) + "..."
      : session.prompt;
    this.deliverToTelegram(session, `↩️ [${session.name}] Launched:\n${promptSummary}`, "launched");

    return session;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private persistSession(session: Session): void {
    const alreadyPersisted = this.persistedSessions.has(session.id);
    if (!alreadyPersisted) {
      this.recordSessionMetrics(session);
    }

    const info: PersistedSessionInfo = {
      sessionId: session.id,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      completedAt: session.completedAt,
      status: session.status,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
    };

    this.persistedSessions.set(session.id, info);
    this.persistedSessions.set(session.name, info);
    console.log(`[SessionManager] Persisted session ${session.name} [${session.id}]`);
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.persistedSessions.get(ref);
  }

  listPersistedSessions(): PersistedSessionInfo[] {
    const seen = new Set<string>();
    const result: PersistedSessionInfo[] = [];
    for (const info of this.persistedSessions.values()) {
      if (!seen.has(info.sessionId)) {
        seen.add(info.sessionId);
        result.push(info);
      }
    }
    return result.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  private recordSessionMetrics(session: Session): void {
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
        prompt: session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt,
      };
    }
  }

  getMetrics(): SessionMetrics {
    return { ...this._metrics };
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  resolve(idOrName: string): Session | undefined {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;
    for (const session of this.sessions.values()) {
      if (session.name === idOrName) return session;
    }
    return undefined;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(filter?: SessionStatus | "all"): Session[] {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  // ─── Kill ─────────────────────────────────────────────────────────────────

  kill(id: string): boolean {
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

  killAll(): void {
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

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (
        session.completedAt &&
        (session.status === "completed" || session.status === "failed" || session.status === "killed") &&
        now - session.completedAt > CLEANUP_MAX_AGE_MS
      ) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
      }
    }

    // Evict oldest persisted sessions when over the cap
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
  private buildDeliverArgs(originChannel?: string): string[] {
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
  private wakeAgent(session: Session, eventText: string, telegramText: string, label: string): void {
    this.deliverToTelegram(session, telegramText, label);

    const agentId = session.originAgentId?.trim();
    if (!agentId) {
      console.warn(`[SessionManager] No originAgentId for ${label} session=${session.id}, falling back to system event`);
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }

    const deliverArgs = this.buildDeliverArgs(session.originChannel);
    const child = spawn("openclaw", ["agent", "--agent", agentId, "--message", eventText, ...deliverArgs], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`[SessionManager] Spawned detached wake for agent=${agentId}, ${label} session=${session.id} (pid=${child.pid})`);
  }

  /**
   * Send an informational notification to Telegram WITHOUT waking the agent.
   * Used for: ↩️ Launched, ↩️ Responded, ❌ Failed, ⛔ Killed.
   */
  deliverToTelegram(session: Session, notificationText: string, label: string): void {
    if (!this.notificationRouter) {
      console.warn(`[SessionManager] Cannot deliver ${label} to Telegram for session=${session.id} (no NotificationRouter)`);
      return;
    }
    const channel = session.originChannel || "unknown";
    console.log(`[SessionManager] Delivering ${label} to Telegram for session=${session.id} via channel=${channel}`);
    this.notificationRouter.emitToChannel(channel, notificationText);
  }

  private fireSystemEventWithRetry(eventText: string, label: string, sessionId: string): void {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[SessionManager] System event failed for ${label} session=${sessionId}: ${err.message}`);
        if (stderr) console.error(`[SessionManager] stderr: ${stderr}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr, _retryStdout, retryStderr) => {
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
  private triggerAgentEvent(session: Session): void {
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
        `Use iflow_output(session='${session.id}', full=true) to get the full result.`,
      ].join("\n");

      const cleanPreview = preview.replace(/[*`_~]/g, "");
      const telegramLines = [
        `✅ [${session.name}] Completed`,
        `   📁 ${session.workdir}`,
        `   ⏱️ ${formatDuration(session.duration)}`,
      ];
      if (cleanPreview.trim()) telegramLines.push(``, cleanPreview);
      const telegramText = telegramLines.join("\n");

      console.log(`[SessionManager] Triggering agent wake for completed session=${session.id}`);
      this.wakeAgent(session, eventText, telegramText, "completed");
    } else {
      const emoji = status === "killed" ? "⛔" : "❌";
      const promptSummary = session.prompt.length > 60
        ? session.prompt.slice(0, 60) + "..."
        : session.prompt;

      const notificationText = [
        `${emoji} [${session.name}] ${status === "killed" ? "Killed" : "Failed"}`,
        `   📁 ${session.workdir}`,
        `   📝 "${promptSummary}"`,
        ...(session.error ? [`   ⚠️ ${session.error}`] : []),
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
  private triggerWaitingForInputEvent(session: Session): void {
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) preview = preview.slice(-500);

    const telegramText = `🔔 [${session.name}] iFlow asks:\n${preview.length > 200 ? preview.slice(-200) : preview}`;

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
      `Use iflow_respond(session='${session.id}', message='...') to send a reply, or iflow_output(session='${session.id}') to see full context.`,
    ].join("\n");

    this.wakeAgent(session, eventText, telegramText, "waiting");
  }
}
