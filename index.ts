import { makeIFlowLaunchTool } from "./src/tools/iflow-launch";
import { makeIFlowRespondTool } from "./src/tools/iflow-respond";
import { makeIFlowFgTool } from "./src/tools/iflow-fg";
import { makeIFlowBgTool } from "./src/tools/iflow-bg";
import { makeIFlowKillTool } from "./src/tools/iflow-kill";
import { makeIFlowOutputTool } from "./src/tools/iflow-output";
import { makeIFlowSessionsTool } from "./src/tools/iflow-sessions";
import { makeIFlowStatsTool } from "./src/tools/iflow-stats";
import { registerIFlowCommand } from "./src/commands/iflow";
import { registerIFlowSessionsCommand } from "./src/commands/iflow-sessions";
import { registerIFlowKillCommand } from "./src/commands/iflow-kill";
import { registerIFlowFgCommand } from "./src/commands/iflow-fg";
import { registerIFlowBgCommand } from "./src/commands/iflow-bg";
import { registerIFlowRespondCommand } from "./src/commands/iflow-respond";
import { registerIFlowStatsCommand } from "./src/commands/iflow-stats";
import { registerIFlowResumeCommand } from "./src/commands/iflow-resume";
import { registerGatewayMethods } from "./src/gateway";
import { SessionManager } from "./src/session-manager";
import { NotificationRouter } from "./src/notifications";
import {
  setSessionManager,
  setNotificationRouter,
  setPluginConfig,
  pluginConfig,
  parseChannel,
} from "./src/shared";
import { execFile } from "child_process";

// Plugin register function — called by OpenClaw when loading the plugin
export function register(api: any) {
  let sm: SessionManager | null = null;
  let nr: NotificationRouter | null = null;
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Tools (factory pattern — each invocation receives calling agent's context) ───

  const logCtx = (toolName: string, ctx: any) => {
    console.log(`[PLUGIN] registerTool factory called for ${toolName}`);
    console.log(`[PLUGIN]   ctx.agentId=${ctx?.agentId}`);
    console.log(`[PLUGIN]   ctx.workspaceDir=${ctx?.workspaceDir}`);
    console.log(`[PLUGIN]   ctx.messageChannel=${ctx?.messageChannel}`);
    console.log(`[PLUGIN]   ctx.agentAccountId=${ctx?.agentAccountId}`);
  };

  api.registerTool((ctx: any) => { logCtx("iflow_launch", ctx); return makeIFlowLaunchTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_respond", ctx); return makeIFlowRespondTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_fg", ctx); return makeIFlowFgTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_bg", ctx); return makeIFlowBgTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_kill", ctx); return makeIFlowKillTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_output", ctx); return makeIFlowOutputTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_sessions", ctx); return makeIFlowSessionsTool(ctx); }, { optional: false });
  api.registerTool((ctx: any) => { logCtx("iflow_stats", ctx); return makeIFlowStatsTool(ctx); }, { optional: false });

  // ─── Commands ────────────────────────────────────────────────────────────────────

  registerIFlowCommand(api);
  registerIFlowSessionsCommand(api);
  registerIFlowKillCommand(api);
  registerIFlowFgCommand(api);
  registerIFlowBgCommand(api);
  registerIFlowRespondCommand(api);
  registerIFlowStatsCommand(api);
  registerIFlowResumeCommand(api);

  // ─── Gateway RPC methods ──────────────────────────────────────────────────────────

  registerGatewayMethods(api);

  // ─── Service lifecycle ────────────────────────────────────────────────────────────

  api.registerService({
    id: "openclaw-iflow-plugin",
    start: () => {
      const config = api.pluginConfig ?? api.getConfig?.() ?? {};
      console.log("[iflow-plugin] Raw config from getConfig():", JSON.stringify(config));

      // Apply config to global pluginConfig
      setPluginConfig(config);

      // Create SessionManager
      sm = new SessionManager(
        pluginConfig.maxSessions,
        pluginConfig.maxPersistedSessions,
      );
      setSessionManager(sm);

      // Build the sendMessage function for NotificationRouter
      // Routes messages to the correct channel via `openclaw message send` CLI
      const sendMessage = (channelId: string, text: string) => {
        // Parse fallback channel from config
        let fallbackChannel = "telegram";
        let fallbackTarget = "";
        let fallbackAccount: string | undefined;

        if (pluginConfig.fallbackChannel?.includes("|")) {
          const parsed = parseChannel(pluginConfig.fallbackChannel);
          fallbackChannel = parsed.channel;
          fallbackAccount = parsed.account;
          fallbackTarget = parsed.target;
        }

        let channel = fallbackChannel;
        let target = fallbackTarget;
        let account: string | undefined = fallbackAccount;

        if (!channelId || channelId === "unknown") {
          if (!fallbackTarget) {
            console.warn(`[iflow-plugin] sendMessage: no channelId and no fallbackChannel configured — message dropped`);
            return;
          }
          console.log(`[iflow-plugin] sendMessage: channelId="${channelId}", using fallback ${fallbackChannel}|${fallbackTarget}`);
        } else if (channelId.includes("|")) {
          const parsed = parseChannel(channelId);
          channel = parsed.channel;
          account = parsed.account;
          target = parsed.target;
        } else if (/^-?\d+$/.test(channelId)) {
          channel = "telegram";
          target = channelId;
        } else if (fallbackTarget) {
          console.log(`[iflow-plugin] sendMessage: unrecognized channelId="${channelId}", using fallback`);
        } else {
          console.warn(`[iflow-plugin] sendMessage: unrecognized channelId="${channelId}" and no fallbackChannel — message dropped`);
          return;
        }

        console.log(`[iflow-plugin] sendMessage -> channel=${channel}, target=${target}${account ? `, account=${account}` : ""}, textLen=${text.length}`);

        const cliArgs = ["message", "send", "--channel", channel];
        if (account) cliArgs.push("--account", account);
        cliArgs.push("--target", target, "-m", text);

        execFile("openclaw", cliArgs, { timeout: 15_000 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[iflow-plugin] sendMessage CLI ERROR: ${err.message}`);
            if (stderr) console.error(`[iflow-plugin] sendMessage CLI STDERR: ${stderr}`);
          } else {
            console.log(`[iflow-plugin] sendMessage CLI OK -> channel=${channel}, target=${target}`);
            if (stdout.trim()) console.log(`[iflow-plugin] sendMessage CLI STDOUT: ${stdout.trim()}`);
          }
        });
      };

      // Create NotificationRouter and wire into SessionManager
      nr = new NotificationRouter(sendMessage);
      setNotificationRouter(nr);
      sm.notificationRouter = nr;

      // Start long-running session reminder check (every 60s)
      nr.startReminderCheck(() => sm?.list("running") ?? []);

      // GC interval: clean up completed sessions every 5 minutes
      cleanupInterval = setInterval(() => sm!.cleanup(), 5 * 60 * 1000);

      console.log(`[iflow-plugin] Service started. maxSessions=${pluginConfig.maxSessions}, fallbackChannel=${pluginConfig.fallbackChannel ?? "none"}`);
    },
    stop: () => {
      console.log("[iflow-plugin] Service stopping...");
      if (nr) nr.stop();
      if (sm) sm.killAll();
      if (cleanupInterval) clearInterval(cleanupInterval);
      cleanupInterval = null;
      sm = null;
      nr = null;
      setSessionManager(null);
      setNotificationRouter(null);
      console.log("[iflow-plugin] Service stopped.");
    },
  });
}
