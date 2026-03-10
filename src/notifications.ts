import type { Session } from "./session";
import { formatDuration } from "./shared";

export type SendMessageFn = (channelId: string, text: string) => void;

interface DebounceEntry {
  buffer: string;
  timer: ReturnType<typeof setTimeout>;
}

const DEBOUNCE_MS = 500;
const LONG_RUNNING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class NotificationRouter {
  private sendMessage: SendMessageFn;
  private debounceMap: Map<string, DebounceEntry> = new Map();
  private longRunningReminded: Set<string> = new Set();
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private getActiveSessions: (() => Session[]) | null = null;

  constructor(sendMessage: SendMessageFn) {
    this.sendMessage = (channelId: string, text: string) => {
      console.log(`[NotificationRouter] sendMessage -> channel=${channelId}, textLen=${text.length}, preview=${text.slice(0, 120)}`);
      sendMessage(channelId, text);
    };
    console.log("[NotificationRouter] Initialized");
  }

  startReminderCheck(getActiveSessions: () => Session[]): void {
    this.getActiveSessions = getActiveSessions;
    this.reminderInterval = setInterval(() => this.checkLongRunning(), 60_000);
  }

  stop(): void {
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    for (const [key, entry] of this.debounceMap) {
      clearTimeout(entry.timer);
      if (entry.buffer) {
        // key format: "sessionId|channelId" — channelId itself may contain "|"
        // so we only split on the FIRST "|"
        const firstPipe = key.indexOf("|");
        const channelId = firstPipe >= 0 ? key.slice(firstPipe + 1) : key;
        this.sendMessage(channelId, entry.buffer);
      }
    }
    this.debounceMap.clear();
    this.longRunningReminded.clear();
  }

  // ─── Foreground streaming ─────────────────────────────────────────────────

  onAssistantText(session: Session, text: string): void {
    console.log(`[NotificationRouter] onAssistantText session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}, textLen=${text.length}`);
    if (session.foregroundChannels.size === 0) {
      console.log(`[NotificationRouter] onAssistantText SKIPPED — no foreground channels`);
      return;
    }
    for (const channelId of session.foregroundChannels) {
      console.log(`[NotificationRouter] appendDebounced -> session=${session.id}, channel=${channelId}`);
      this.appendDebounced(session.id, channelId, text);
    }
  }

  onToolUse(session: Session, toolName: string, status: string): void {
    console.log(`[NotificationRouter] onToolUse session=${session.id}, tool=${toolName}, status=${status}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    if (session.foregroundChannels.size === 0) return;

    // Only show tool start events (not intermediate results) to keep output clean
    if (status !== "start" && status !== "running" && status !== "unknown") return;

    const line = `🔧 ${toolName}`;
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
      this.sendMessage(channelId, line);
    }
  }

  // ─── Completion notifications ─────────────────────────────────────────────

  onSessionComplete(session: Session): void {
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

  onLimitReached(session: Session): void {
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    const duration = formatDuration(session.duration);
    const msg = [
      `⛔ Session limit reached — ${session.name} [${session.id}] (${duration})`,
      `   📁 ${session.workdir}`,
    ].join("\n");
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }
    this.cleanupSession(session.id);
  }

  // ─── Waiting for input ────────────────────────────────────────────────────

  onWaitingForInput(session: Session): void {
    console.log(`[NotificationRouter] onWaitingForInput session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    for (const channelId of session.foregroundChannels) {
      const duration = formatDuration(session.duration);
      const msg = [
        `💬 Session ${session.name} [${session.id}] is waiting for input (${duration})`,
        `   Use iflow_respond to reply.`,
      ].join("\n");
      this.sendMessage(channelId, msg);
    }
  }

  // ─── Public passthrough ───────────────────────────────────────────────────

  emitToChannel(channelId: string, text: string): void {
    this.sendMessage(channelId, text);
  }

  // ─── Long-running reminder ────────────────────────────────────────────────

  private checkLongRunning(): void {
    if (!this.getActiveSessions) return;
    const sessions = this.getActiveSessions();
    const now = Date.now();
    for (const session of sessions) {
      if (
        (session.status === "running" || session.status === "starting") &&
        session.foregroundChannels.size === 0 &&
        !this.longRunningReminded.has(session.id) &&
        now - session.startedAt > LONG_RUNNING_THRESHOLD_MS
      ) {
        this.longRunningReminded.add(session.id);
        const duration = formatDuration(now - session.startedAt);
        const msg = [
          `⏱️ Session ${session.name} [${session.id}] running for ${duration}`,
          `   📁 ${session.workdir}`,
          `   Use iflow_fg to check on it, or iflow_kill to stop it.`,
        ].join("\n");
        if (session.originChannel) {
          this.sendMessage(session.originChannel, msg);
        }
      }
    }
  }

  // ─── Debounce internals ───────────────────────────────────────────────────

  private debounceKey(sessionId: string, channelId: string): string {
    return `${sessionId}|${channelId}`;
  }

  private appendDebounced(sessionId: string, channelId: string, text: string): void {
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

  private flushDebounced(sessionId: string, channelId: string): void {
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

  private cleanupSession(sessionId: string): void {
    for (const key of this.debounceMap.keys()) {
      if (key.startsWith(`${sessionId}|`)) {
        const entry = this.debounceMap.get(key)!;
        clearTimeout(entry.timer);
        this.debounceMap.delete(key);
      }
    }
    this.longRunningReminded.delete(sessionId);
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatCompletionNotification(session: Session): string {
  const duration = formatDuration(session.duration);
  const promptSummary = session.prompt.length > 60
    ? session.prompt.slice(0, 60) + "..."
    : session.prompt;

  if (session.status === "completed") {
    return [
      `✅ iFlow [${session.id}] completed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
    ].join("\n");
  }

  if (session.status === "failed") {
    const errorDetail = session.error ? `   ⚠️ ${session.error}` : "";
    return [
      `❌ iFlow [${session.id}] failed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
      ...(errorDetail ? [errorDetail] : []),
    ].join("\n");
  }

  if (session.status === "killed") {
    return [
      `⛔ iFlow [${session.id}] killed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
    ].join("\n");
  }

  return `Session [${session.id}] finished with status: ${session.status}`;
}
