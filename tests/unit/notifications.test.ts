import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationRouter } from "../../src/notifications";
import type { Session } from "../../src/session";

// Minimal mock session factory
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-id",
    name: "test-session",
    prompt: "Fix the bug",
    workdir: "/home/user/project",
    status: "running",
    startedAt: Date.now() - 5000,
    completedAt: undefined,
    duration: 5000,
    foregroundChannels: new Set<string>(),
    outputBuffer: [],
    getOutput: (lines?: number) => [],
    markFgOutputSeen: vi.fn(),
    ...overrides,
  } as unknown as Session;
}

describe("NotificationRouter", () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let router: NotificationRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    sendMessage = vi.fn();
    router = new NotificationRouter(sendMessage);
  });

  afterEach(() => {
    router.stop();
    vi.useRealTimers();
  });

  // ─── onAssistantText ──────────────────────────────────────────────────────

  describe("onAssistantText", () => {
    it("does NOT send when no foreground channels", () => {
      const session = makeSession({ foregroundChannels: new Set() });
      router.onAssistantText(session, "Hello world");
      vi.runAllTimers();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends debounced message to foreground channel", () => {
      const session = makeSession({ foregroundChannels: new Set(["dingtalk|user123"]) });
      router.onAssistantText(session, "Hello ");
      router.onAssistantText(session, "world");
      // Before debounce fires — nothing sent yet
      expect(sendMessage).not.toHaveBeenCalled();
      // Fire debounce timer
      vi.runAllTimers();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("dingtalk|user123", "Hello world");
    });

    it("sends to multiple foreground channels", () => {
      const session = makeSession({
        foregroundChannels: new Set(["dingtalk|user1", "dingtalk|user2"]),
      });
      router.onAssistantText(session, "Hi");
      vi.runAllTimers();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const targets = sendMessage.mock.calls.map((c) => c[0]);
      expect(targets).toContain("dingtalk|user1");
      expect(targets).toContain("dingtalk|user2");
    });
  });

  // ─── onToolUse ────────────────────────────────────────────────────────────

  describe("onToolUse", () => {
    it("does NOT send when no foreground channels", () => {
      const session = makeSession({ foregroundChannels: new Set() });
      router.onToolUse(session, "bash", "start");
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends tool indicator for start status", () => {
      const session = makeSession({ foregroundChannels: new Set(["dingtalk|user123"]) });
      router.onToolUse(session, "bash", "start");
      expect(sendMessage).toHaveBeenCalledWith("dingtalk|user123", "🔧 bash");
    });

    it("does NOT send for non-start statuses", () => {
      const session = makeSession({ foregroundChannels: new Set(["dingtalk|user123"]) });
      router.onToolUse(session, "bash", "completed");
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── onSessionComplete ────────────────────────────────────────────────────

  describe("onSessionComplete", () => {
    it("sends completion notification for completed session", () => {
      const session = makeSession({
        status: "completed",
        foregroundChannels: new Set(["dingtalk|user123"]),
        completedAt: Date.now(),
      });
      router.onSessionComplete(session);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const msg: string = sendMessage.mock.calls[0][1];
      expect(msg).toContain("✅");
      expect(msg).toContain("test-id");
    });

    it("sends failure notification for failed session", () => {
      const session = makeSession({
        status: "failed",
        error: "Connection refused",
        foregroundChannels: new Set(["dingtalk|user123"]),
        completedAt: Date.now(),
      });
      router.onSessionComplete(session);
      const msg: string = sendMessage.mock.calls[0][1];
      expect(msg).toContain("❌");
    });

    it("sends killed notification for killed session", () => {
      const session = makeSession({
        status: "killed",
        foregroundChannels: new Set(["dingtalk|user123"]),
        completedAt: Date.now(),
      });
      router.onSessionComplete(session);
      const msg: string = sendMessage.mock.calls[0][1];
      expect(msg).toContain("⛔");
    });
  });

  // ─── onWaitingForInput ────────────────────────────────────────────────────

  describe("onWaitingForInput", () => {
    it("sends waiting-for-input notification to foreground channels", () => {
      const session = makeSession({
        foregroundChannels: new Set(["dingtalk|user123"]),
      });
      router.onWaitingForInput(session);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const msg: string = sendMessage.mock.calls[0][1];
      expect(msg).toContain("💬");
      expect(msg).toContain("test-session");
      expect(msg).toContain("iflow_respond");
    });

    it("does NOT send when no foreground channels", () => {
      const session = makeSession({ foregroundChannels: new Set() });
      router.onWaitingForInput(session);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── stop() ──────────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("flushes pending debounce buffers on stop", () => {
      const session = makeSession({ foregroundChannels: new Set(["dingtalk|user123"]) });
      router.onAssistantText(session, "Buffered text");
      // Timer not fired yet
      expect(sendMessage).not.toHaveBeenCalled();
      // stop() should flush
      router.stop();
      expect(sendMessage).toHaveBeenCalledWith("dingtalk|user123", "Buffered text");
    });

    it("clears reminder interval on stop", () => {
      const getActiveSessions = vi.fn(() => []);
      router.startReminderCheck(getActiveSessions);
      router.stop();
      // After stop, advancing time should NOT trigger reminder checks
      vi.advanceTimersByTime(120_000);
      expect(getActiveSessions).not.toHaveBeenCalled();
    });
  });

  // ─── emitToChannel ────────────────────────────────────────────────────────

  describe("emitToChannel", () => {
    it("sends message directly to specified channel", () => {
      router.emitToChannel("dingtalk|user123", "Direct message");
      expect(sendMessage).toHaveBeenCalledWith("dingtalk|user123", "Direct message");
    });
  });
});
