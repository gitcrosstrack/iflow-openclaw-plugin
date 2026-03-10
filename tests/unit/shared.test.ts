import { describe, it, expect, beforeEach } from "vitest";
import {
  formatDuration,
  generateSessionName,
  parseChannel,
  setPluginConfig,
  pluginConfig,
} from "../../src/shared";

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(120000)).toBe("2m 0s");
    expect(formatDuration(90500)).toBe("1m 30s");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatDuration(3661000)).toBe("1h 1m 1s");
    expect(formatDuration(3600000)).toBe("1h 0m 0s");
    expect(formatDuration(7322000)).toBe("2h 2m 2s");
  });
});

describe("generateSessionName", () => {
  it("generates kebab-case name from prompt", () => {
    expect(generateSessionName("Fix the auth bug")).toBe("fix-the-auth-bug");
  });

  it("takes at most 4 words", () => {
    expect(generateSessionName("Fix the authentication bug in src/auth.ts")).toBe("fix-the-authentication-bug");
  });

  it("removes special characters", () => {
    expect(generateSessionName("Fix bug in src/auth.ts!")).toBe("fix-bug-in-srcauthts");
  });

  it("handles empty prompt", () => {
    expect(generateSessionName("")).toBe("iflow-session");
  });

  it("handles prompt with only special chars", () => {
    expect(generateSessionName("!!! ???")).toBe("iflow-session");
  });

  it("truncates to 32 chars", () => {
    const result = generateSessionName("a b c d e f g h i j k l m n o p");
    expect(result.length).toBeLessThanOrEqual(32);
  });
});

describe("parseChannel", () => {
  it("parses dingtalk|userId format", () => {
    const result = parseChannel("dingtalk|user123456");
    expect(result).toEqual({ channel: "dingtalk", target: "user123456" });
  });

  it("parses dingtalk|account|target format", () => {
    const result = parseChannel("dingtalk|my-account|user123456");
    expect(result).toEqual({ channel: "dingtalk", account: "my-account", target: "user123456" });
  });

  it("parses bare numeric ID as dingtalk", () => {
    const result = parseChannel("123456789");
    expect(result).toEqual({ channel: "dingtalk", target: "123456789" });
  });

  it("parses negative numeric ID as dingtalk", () => {
    const result = parseChannel("-100123456");
    expect(result).toEqual({ channel: "dingtalk", target: "-100123456" });
  });

  it("parses unknown string as dingtalk", () => {
    const result = parseChannel("someUserId");
    expect(result).toEqual({ channel: "dingtalk", target: "someUserId" });
  });

  it("returns empty target for unknown/empty channelId", () => {
    const result = parseChannel("unknown");
    expect(result.target).toBe("");
  });

  it("returns empty target for empty string", () => {
    const result = parseChannel("");
    expect(result.target).toBe("");
  });

  it("parses telegram channel correctly", () => {
    const result = parseChannel("telegram|bot-account|987654321");
    expect(result).toEqual({ channel: "telegram", account: "bot-account", target: "987654321" });
  });

  it("parses cid group conversation", () => {
    const result = parseChannel("dingtalk|cidXXXXXXXXXX");
    expect(result).toEqual({ channel: "dingtalk", target: "cidXXXXXXXXXX" });
  });
});

describe("setPluginConfig", () => {
  beforeEach(() => {
    // Reset to defaults — also clear optional fields to avoid test pollution
    setPluginConfig({
      maxSessions: 5,
      idleTimeoutMinutes: 30,
      maxPersistedSessions: 50,
      maxAutoResponds: 10,
      iflowTimeout: 300_000,
      skipSafetyChecks: false,
    });
    // Explicitly clear optional fields that setPluginConfig won't reset
    pluginConfig.fallbackChannel = undefined;
    pluginConfig.agentChannels = undefined;
    pluginConfig.defaultWorkdir = undefined;
    pluginConfig.permissionMode = undefined;
  });

  it("updates maxSessions when number provided", () => {
    setPluginConfig({ maxSessions: 10 });
    expect(pluginConfig.maxSessions).toBe(10);
  });

  it("updates fallbackChannel when string provided", () => {
    setPluginConfig({ fallbackChannel: "dingtalk|user123" });
    expect(pluginConfig.fallbackChannel).toBe("dingtalk|user123");
  });

  it("updates agentChannels when object provided", () => {
    const channels = { "/home/user/project": "dingtalk|user123" };
    setPluginConfig({ agentChannels: channels });
    expect(pluginConfig.agentChannels).toEqual(channels);
  });

  it("ignores non-number for maxSessions", () => {
    setPluginConfig({ maxSessions: "not-a-number" as any });
    expect(pluginConfig.maxSessions).toBe(5);
  });

  it("updates skipSafetyChecks when boolean provided", () => {
    setPluginConfig({ skipSafetyChecks: true });
    expect(pluginConfig.skipSafetyChecks).toBe(true);
  });

  it("updates iflowTimeout", () => {
    setPluginConfig({ iflowTimeout: 600_000 });
    expect(pluginConfig.iflowTimeout).toBe(600_000);
  });

  it("does not affect other fields when only one is updated", () => {
    const prevMaxSessions = pluginConfig.maxSessions;
    setPluginConfig({ iflowTimeout: 120_000 });
    expect(pluginConfig.maxSessions).toBe(prevMaxSessions);
  });
});
