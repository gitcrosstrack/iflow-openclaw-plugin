import { Type } from "@sinclair/typebox";
import { getSessionManager } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowBgTool(ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_bg",
    description:
      "Send an iFlow session back to background — stop streaming output to this channel. The session continues running; you will be notified on completion.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session ID or name to send to background",
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

      const channelId = ctx.messageChannel || "unknown";

      if (!session.foregroundChannels.has(channelId)) {
        return {
          content: [
            {
              type: "text",
              text: `Session "${session.name}" is not in foreground for this channel. Nothing to do.`,
            },
          ],
        };
      }

      // Save current output offset before removing from foreground
      session.saveFgOutputOffset(channelId);
      session.foregroundChannels.delete(channelId);

      return {
        content: [
          {
            type: "text",
            text: [
              `🔕 [${session.name}] Sent to background.`,
              `   Session continues running. You will be notified on completion.`,
              `   Use iflow_fg to bring it back to foreground.`,
            ].join("\n"),
          },
        ],
      };
    },
  };
}
