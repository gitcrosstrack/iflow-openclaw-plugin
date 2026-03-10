import type { SessionManager } from "./session-manager";
import type { NotificationRouter } from "./notifications";
import type { PluginConfig } from "./types";

// ─── Global singletons ────────────────────────────────────────────────────────

let _sessionManager: SessionManager | null = null;
let _notificationRouter: NotificationRouter | null = null;

export const pluginConfig: PluginConfig = {
  maxSessions: 5,
  idleTimeoutMinutes: 30,
  maxPersistedSessions: 50,
  maxAutoResponds: 10,
  iflowTimeout: 300_000,
  skipSafetyChecks: false,
};

export function setSessionManager(sm: SessionManager | null): void {
  _sessionManager = sm;
}

export function setNotificationRouter(nr: NotificationRouter | null): void {
  _notificationRouter = nr;
}

export function setPluginConfig(config: Record<string, any>): void {
  if (typeof config.maxSessions === "number") pluginConfig.maxSessions = config.maxSessions;
  if (typeof config.idleTimeoutMinutes === "number") pluginConfig.idleTimeoutMinutes = config.idleTimeoutMinutes;
  if (typeof config.maxPersistedSessions === "number") pluginConfig.maxPersistedSessions = config.maxPersistedSessions;
  if (typeof config.maxAutoResponds === "number") pluginConfig.maxAutoResponds = config.maxAutoResponds;
  if (typeof config.iflowTimeout === "number") pluginConfig.iflowTimeout = config.iflowTimeout;
  if (typeof config.fallbackChannel === "string") pluginConfig.fallbackChannel = config.fallbackChannel;
  if (typeof config.defaultWorkdir === "string") pluginConfig.defaultWorkdir = config.defaultWorkdir;
  if (typeof config.permissionMode === "string") pluginConfig.permissionMode = config.permissionMode as any;
  if (typeof config.skipSafetyChecks === "boolean") pluginConfig.skipSafetyChecks = config.skipSafetyChecks;
  if (config.agentChannels && typeof config.agentChannels === "object") {
    pluginConfig.agentChannels = config.agentChannels;
  }
}

export function getSessionManager(): SessionManager | null {
  return _sessionManager;
}

export function getNotificationRouter(): NotificationRouter | null {
  return _notificationRouter;
}

// Convenience proxy — modules can import `sessionManager` directly and it will
// always reflect the current singleton (set/cleared by the service lifecycle).
export const sessionManager: SessionManager = new Proxy({} as SessionManager, {
  get(_target, prop) {
    if (!_sessionManager) throw new Error("SessionManager not initialized");
    return (_sessionManager as any)[prop];
  },
});

export const notificationRouter: NotificationRouter = new Proxy({} as NotificationRouter, {
  get(_target, prop) {
    if (!_notificationRouter) throw new Error("NotificationRouter not initialized");
    return (_notificationRouter as any)[prop];
  },
});

// ─── Utility functions ────────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 65000 → "1m 5s", 3661000 → "1h 1m 1s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Generate a kebab-case session name from a prompt string.
 * e.g. "Fix the auth bug in src/auth.ts" → "fix-auth-bug"
 */
export function generateSessionName(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .replace(/-+/g, "-")
    .slice(0, 32)
    || "iflow-session";
}

/**
 * Resolve the origin notification channel for a session.
 * Priority: provided channel → fallbackChannel from config → "unknown"
 */
export function resolveOriginChannel(
  _ctx: { id: string },
  channel?: string,
): string {
  if (channel && channel !== "unknown") return channel;
  if (pluginConfig.fallbackChannel) return pluginConfig.fallbackChannel;
  return "unknown";
}

/**
 * Look up the notification channel for a given workspace directory
 * from the agentChannels config map.
 * Returns undefined if no mapping found.
 */
export function resolveAgentChannel(workdir: string): string | undefined {
  const channels = pluginConfig.agentChannels;
  if (!channels) return undefined;

  // Exact match first
  if (channels[workdir]) return channels[workdir];

  // Prefix match: find the longest matching prefix
  let bestMatch: string | undefined;
  let bestLen = 0;
  for (const [dir, channel] of Object.entries(channels)) {
    if (workdir.startsWith(dir) && dir.length > bestLen) {
      bestMatch = channel;
      bestLen = dir.length;
    }
  }
  return bestMatch;
}

/**
 * Resolve agent ID from a workspace directory by reading the openclaw config.
 * Returns undefined if not found.
 */
export function resolveAgentId(workspaceDir: string): string | undefined {
  // This is a best-effort lookup — the authoritative agentId comes from ctx.agentId
  // We don't have a reliable way to map workspaceDir → agentId without the config,
  // so we return undefined and let the caller fall back to ctx.agentId.
  return undefined;
}

/**
 * Parse a channel string into its components.
 * Supports formats:
 *   "telegram|account|chatId"  → { channel: "telegram", account: "account", target: "chatId" }
 *   "telegram|chatId"          → { channel: "telegram", account: undefined, target: "chatId" }
 *   "chatId"                   → { channel: "telegram", account: undefined, target: "chatId" }
 */
export function parseChannel(channelId: string): {
  channel: string;
  account?: string;
  target: string;
} {
  if (!channelId || channelId === "unknown") {
    return { channel: "telegram", target: "" };
  }

  if (channelId.includes("|")) {
    const parts = channelId.split("|");
    if (parts.length >= 3) {
      return {
        channel: parts[0],
        account: parts[1],
        target: parts.slice(2).join("|"),
      };
    }
    return { channel: parts[0], target: parts[1] };
  }

  // Bare numeric ID — assume DingTalk userId
  if (/^-?\d+$/.test(channelId)) {
    return { channel: "dingtalk", target: channelId };
  }

  return { channel: "dingtalk", target: channelId };
}
