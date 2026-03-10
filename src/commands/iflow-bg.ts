import { getSessionManager } from "../shared";

/**
 * /iflow_bg <session> — Send session to background
 */
export function registerIFlowBgCommand(api: any) {
  api.registerCommand({
    name: "iflow_bg",
    description: "Send an iFlow session to background (stop streaming). Usage: /iflow_bg <session-id-or-name>",
    async execute(args: string, ctx: any) {
      const sm = getSessionManager();
      if (!sm) return "Error: SessionManager not initialized.";

      const ref = args.trim();
      if (!ref) return "Usage: /iflow_bg <session-id-or-name>";

      const session = sm.resolve(ref);
      if (!session) return `Error: Session "${ref}" not found. Use /iflow_sessions to list sessions.`;

      const channelId = ctx?.messageChannel || "unknown";

      if (!session.foregroundChannels.has(channelId)) {
        return `Session "${session.name}" is not in foreground for this channel.`;
      }

      session.saveFgOutputOffset(channelId);
      session.foregroundChannels.delete(channelId);

      return [
        `🔕 [${session.name}] Sent to background.`,
        `   Session continues running. You will be notified on completion.`,
        `   Use /iflow_fg ${session.name} to bring it back.`,
      ].join("\n");
    },
  });
}
