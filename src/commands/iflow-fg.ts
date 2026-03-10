import { getSessionManager } from "../shared";

/**
 * /iflow_fg <session> — Bring session to foreground
 */
export function registerIFlowFgCommand(api: any) {
  api.registerCommand({
    name: "iflow_fg",
    description: "Bring an iFlow session to foreground (stream output). Usage: /iflow_fg <session-id-or-name>",
    async execute(args: string, ctx: any) {
      const sm = getSessionManager();
      if (!sm) return "Error: SessionManager not initialized.";

      const ref = args.trim();
      if (!ref) return "Usage: /iflow_fg <session-id-or-name>";

      const session = sm.resolve(ref);
      if (!session) return `Error: Session "${ref}" not found. Use /iflow_sessions to list sessions.`;

      const channelId = ctx?.messageChannel || "unknown";
      const catchup = session.getCatchupOutput(channelId);

      session.foregroundChannels.add(channelId);
      session.markFgOutputSeen(channelId);

      const statusLine = session.status === "running"
        ? "Session is running — streaming output to this channel."
        : `Session has ${session.status}.`;

      const lines = [
        `📺 [${session.name}] Foreground mode activated.`,
        `   ${statusLine}`,
        `   Use /iflow_bg ${session.name} to stop streaming.`,
      ];

      if (catchup.length > 0) {
        lines.push(``, `--- Catchup output ---`);
        lines.push(...catchup);
        lines.push(`--- End catchup ---`);
      }

      return lines.join("\n");
    },
  });
}
