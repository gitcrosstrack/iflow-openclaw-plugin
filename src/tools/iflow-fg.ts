import { Type } from "@sinclair/typebox";
import { getSessionManager } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowFgTool(ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_fg",
    description:
      "Bring an iFlow session to the foreground — stream its output in real time to this channel. Includes catchup of any output missed while in background.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session ID or name to bring to foreground",
      }),
    }),
    async execute(_id: string, params: any) {
      const sm = getSessionManager();
      if (!sm) {
        return {
          content: [{ type: "text", text: "Error: SessionManager not initialized." }],
        };
      }

      const session = sm.resolve(params.session);
      if (!session) {
        return {
          content: [{ type: "text", text: `Error: Session "${params.session}" not found. Use iflow_sessions to list sessions.` }],
        };
      }

      // Determine the channel for this tool call
      const channelId = ctx.messageChannel || "unknown";

      // Send catchup output (output missed while in background)
      const catchup = session.getCatchupOutput(channelId);

      // Register this channel as foreground
      session.foregroundChannels.add(channelId);
      session.markFgOutputSeen(channelId);

      const statusLine = session.status === "running"
        ? `Session is running — streaming output to this channel.`
        : `Session has ${session.status}.`;

      const lines = [
        `📺 [${session.name}] Foreground mode activated.`,
        `   ${statusLine}`,
        `   Use iflow_bg to stop streaming.`,
      ];

      if (catchup.length > 0) {
        lines.push(``, `--- Catchup output ---`);
        lines.push(...catchup);
        lines.push(`--- End catchup ---`);
      } else if (session.status === "running") {
        lines.push(`   (No missed output — waiting for new output...)`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  };
}
