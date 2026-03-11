/**
 * Context provided by OpenClaw's tool factory pattern.
 * When registerTool receives a factory function instead of a static tool object,
 * it calls the factory with this context, giving each tool access to the
 * calling agent's runtime information.
 */
export interface IFlowPluginToolContext {
  config?: Record<string, any>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

export type SessionStatus = "starting" | "running" | "completed" | "failed" | "killed";

export type PermissionMode = "auto" | "manual" | "selective";

export interface SessionConfig {
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  /** iFlow session timeout in milliseconds (default: 300000 = 5min) */
  timeout?: number;
  /** Maximum number of turns before session ends */
  maxTurns?: number;
  foreground?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;   // Channel that spawned this session (for background notifications)
  originAgentId?: string;   // Agent ID that launched this session (for targeted wake events)
  permissionMode?: PermissionMode;
  /** Whether to keep session open for multi-turn conversations (default: true) */
  multiTurn?: boolean;
}

export interface IFlowSessionSnapshot {
  id: string;
  name: string;
  status: SessionStatus;
  prompt: string;
  workdir: string;
  model?: string;
  startedAt: number;
  completedAt?: number;
  outputBuffer: string[];
  turnCount: number;
  error?: string;
  originChannel?: string;
  originAgentId?: string;
}

export interface PersistedSessionInfo {
  sessionId: string;       // Internal nanoid session ID
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  completedAt?: number;
  status: SessionStatus;
  originAgentId?: string;
  originChannel?: string;
}

export interface SessionMetrics {
  totalSessions: number;
  sessionsByStatus: {
    completed: number;
    failed: number;
    killed: number;
  };
  totalDurationMs: number;
  sessionsWithDuration: number;
  mostExpensive?: {
    id: string;
    name: string;
    prompt: string;
  };
}

export interface PluginConfig {
  maxSessions: number;
  defaultWorkdir?: string;
  idleTimeoutMinutes: number;
  maxPersistedSessions: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;
  /** iFlow session timeout in milliseconds */
  iflowTimeout?: number;

  /**
   * Map of agent working directories to notification channels.
   * When a tool call cannot resolve the origin channel from context,
   * it checks whether the session workdir matches a key here.
   *
   * Example: { "/home/user/my-agent": "telegram|123456789" }
   */
  agentChannels?: Record<string, string>;

  /**
   * Maximum number of consecutive auto-responds before requiring user input.
   * Resets when the user sends a message via /iflow_respond command. Default: 10.
   */
  maxAutoResponds: number;

  /**
   * Skip ALL pre-launch safety guards. Useful for development/testing.
   * Default: false.
   */
  skipSafetyChecks?: boolean;

  /**
   * Safety-net idle timeout in seconds. If iFlow produces no output for this
   * duration, onWaitingForInput is fired. Default: 600.
   */
  safetyNetIdleSeconds?: number;
}
