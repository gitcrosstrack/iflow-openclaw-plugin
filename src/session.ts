import { IFlowClient, MessageType, StopReason } from "@iflow-ai/iflow-cli-sdk";
import type { IFlowOptions } from "@iflow-ai/iflow-cli-sdk";
import type { SessionConfig, SessionStatus, PermissionMode } from "./types";
import { pluginConfig, generateSessionName } from "./shared";
import { nanoid } from "nanoid";

const OUTPUT_BUFFER_MAX = 200;

export class Session {
  readonly id: string;
  name: string;

  // Config
  readonly prompt: string;
  readonly workdir: string;
  readonly model?: string;
  readonly timeout: number;
  readonly maxTurns?: number;
  private readonly systemPrompt?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode: PermissionMode;
  readonly multiTurn: boolean;

  // State
  status: SessionStatus = "starting";
  error?: string;
  startedAt: number;
  completedAt?: number;
  turnCount: number = 0;

  // iFlow SDK client
  private client: IFlowClient;

  // Output
  outputBuffer: string[] = [];

  // Foreground channels
  foregroundChannels: Set<string> = new Set();

  // Per-channel output offset for catchup
  private fgOutputOffsets: Map<string, number> = new Map();

  // Origin channel / agent
  originChannel?: string;
  readonly originAgentId?: string;

  // Flags
  private waitingForInputFired: boolean = false;

  // Auto-respond safety cap
  autoRespondCount: number = 0;

  // Timers
  private idleTimer?: ReturnType<typeof setTimeout>;
  private safetyNetTimer?: ReturnType<typeof setTimeout>;

  // Event callbacks
  onOutput?: (text: string) => void;
  onToolUse?: (toolName: string, status: string) => void;
  onComplete?: (session: Session) => void;
  onWaitingForInput?: (session: Session) => void;

  constructor(config: SessionConfig, name?: string) {
    this.id = nanoid(8);
    this.name = name ?? generateSessionName(config.prompt);
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = config.model;
    this.timeout = config.timeout ?? pluginConfig.iflowTimeout ?? 300_000;
    this.maxTurns = config.maxTurns;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode ?? "auto";
    this.originChannel = config.originChannel;
    this.originAgentId = config.originAgentId;
    this.multiTurn = config.multiTurn ?? true;
    this.startedAt = Date.now();

    // Build iFlow client options
    const options: IFlowOptions = {
      cwd: this.workdir,
      timeout: this.timeout,
      autoStartProcess: true,
      permissionMode: this.permissionMode,
      ...(this.allowedTools ? { autoApproveTypes: this.allowedTools } : {}),
      ...(this.systemPrompt
        ? {
            sessionSettings: {
              system_prompt: this.systemPrompt,
              ...(this.maxTurns ? { max_turns: this.maxTurns } : {}),
            },
          }
        : this.maxTurns
        ? { sessionSettings: { max_turns: this.maxTurns } }
        : {}),
    };

    this.client = new IFlowClient(options);
  }

  async start(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.sendMessage(this.prompt);
      this.status = "running";
      this.resetIdleTimer();
      // Consume messages in background (non-blocking)
      this.consumeMessages().catch((err) => {
        if (this.status === "starting" || this.status === "running") {
          this.status = "failed";
          this.error = err?.message ?? String(err);
          this.completedAt = Date.now();
          this.clearTimers();
          if (this.onComplete) this.onComplete(this);
        }
      });
    } catch (err: any) {
      this.status = "failed";
      this.error = err?.message ?? String(err);
      this.completedAt = Date.now();
      try { await this.client.disconnect(); } catch {}
    }
  }

  /**
   * Send a follow-up message to a running multi-turn session.
   */
  async sendMessage(text: string): Promise<void> {
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
  kill(): void {
    if (this.status !== "starting" && this.status !== "running") return;
    this.clearTimers();
    this.status = "killed";
    this.completedAt = Date.now();
    this.client.disconnect().catch(() => {});
  }

  // ─── Output management ────────────────────────────────────────────────────

  getOutput(lines?: number): string[] {
    if (lines === undefined) return this.outputBuffer.slice();
    return this.outputBuffer.slice(-lines);
  }

  getCatchupOutput(channelId: string): string[] {
    const lastOffset = this.fgOutputOffsets.get(channelId) ?? 0;
    const available = this.outputBuffer.length;
    if (lastOffset >= available) return [];
    return this.outputBuffer.slice(lastOffset);
  }

  markFgOutputSeen(channelId: string): void {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }

  saveFgOutputOffset(channelId: string): void {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }

  // ─── Auto-respond counter ─────────────────────────────────────────────────

  incrementAutoRespond(): void {
    this.autoRespondCount++;
  }

  resetAutoRespond(): void {
    this.autoRespondCount = 0;
  }

  // ─── Duration ─────────────────────────────────────────────────────────────

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  // ─── Private: message consumption ────────────────────────────────────────

  private async consumeMessages(): Promise<void> {
    for await (const msg of this.client.receiveMessages()) {
      // Reset safety-net timer on every incoming message
      this.resetSafetyNetTimer();

      if (msg.type === MessageType.ASSISTANT) {
        this.waitingForInputFired = false;
        const text: string | undefined = msg.chunk?.text;
        if (text) {
          this.appendOutput(text);
          if (this.onOutput) {
            console.log(`[Session] ${this.id} calling onOutput, textLen=${text.length}`);
            this.onOutput(text);
          }
        }
      } else if (msg.type === MessageType.TOOL_CALL) {
        const toolName: string = msg.toolName ?? "unknown_tool";
        const status: string = msg.status ?? "unknown";
        console.log(`[Session] ${this.id} tool_call: ${toolName} (${status})`);
        if (this.onToolUse) {
          this.onToolUse(toolName, status);
        }
      } else if (msg.type === MessageType.PLAN) {
        // Render plan entries into the output buffer for visibility
        if (msg.entries && Array.isArray(msg.entries)) {
          const planLines = msg.entries.map((e: any) => {
            const icon = e.status === "completed" ? "✅" : "⏳";
            return `${icon} [${e.priority ?? "-"}] ${e.content}`;
          });
          const planText = "📋 Plan:\n" + planLines.join("\n");
          this.appendOutput(planText);
          if (this.onOutput) this.onOutput(planText);
        }
      } else if (msg.type === MessageType.TASK_FINISH) {
        this.clearSafetyNetTimer();
        this.turnCount++;

        const stopReason = msg.stopReason;

        if (this.multiTurn && stopReason === StopReason.END_TURN) {
          // End of one turn in multi-turn mode — stay open, notify waiting for input
          console.log(`[Session] ${this.id} multi-turn end-of-turn (turn ${this.turnCount}), staying open`);
          this.resetIdleTimer();
          if (this.onWaitingForInput && !this.waitingForInputFired) {
            console.log(`[Session] ${this.id} calling onWaitingForInput`);
            this.waitingForInputFired = true;
            this.onWaitingForInput(this);
          }
          // Do NOT break — keep iterating for next turn messages
        } else {
          // Session truly done
          this.clearTimers();
          if (stopReason === StopReason.END_TURN || stopReason === StopReason.MAX_TOKENS) {
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
      } else if ((msg.type as string) === "error" || (msg as any).code) {
        // ERROR message from iFlow
        this.clearTimers();
        this.status = "failed";
        this.error = (msg as any).message ?? `iFlow error code: ${(msg as any).code}`;
        this.completedAt = Date.now();
        console.log(`[Session] ${this.id} error received: ${this.error}`);
        if (this.onComplete) this.onComplete(this);
        break;
      }
    }

    // Stream ended without TASK_FINISH — treat as completed if still running
    if (this.status === "running" || this.status === "starting") {
      this.clearTimers();
      this.status = "completed";
      this.completedAt = Date.now();
      if (this.onComplete) this.onComplete(this);
    }
  }

  private appendOutput(text: string): void {
    this.outputBuffer.push(text);
    if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_BUFFER_MAX);
    }
  }

  // ─── Timers ───────────────────────────────────────────────────────────────

  private resetSafetyNetTimer(): void {
    this.clearSafetyNetTimer();
    const idleMs = (pluginConfig.safetyNetIdleSeconds ?? 600) * 1000;
    this.safetyNetTimer = setTimeout(() => {
      this.safetyNetTimer = undefined;
      if (this.status === "running" && this.onWaitingForInput && !this.waitingForInputFired) {
        console.log(`[Session] ${this.id} no messages for ${idleMs / 1000}s — firing onWaitingForInput (safety-net)`);
        this.waitingForInputFired = true;
        this.onWaitingForInput(this);
      }
    }, idleMs);
  }

  private clearSafetyNetTimer(): void {
    if (this.safetyNetTimer) {
      clearTimeout(this.safetyNetTimer);
      this.safetyNetTimer = undefined;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 30) * 60 * 1000;
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") {
        console.log(`[Session] ${this.id} idle timeout reached (${pluginConfig.idleTimeoutMinutes ?? 30}min), auto-killing`);
        this.kill();
      }
    }, idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    this.clearSafetyNetTimer();
  }
}
