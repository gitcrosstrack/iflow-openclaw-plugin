import { Type } from "@sinclair/typebox";
import { getSessionManager, pluginConfig } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowRespondTool(ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_respond",
    description:
      "Send a follow-up message to a running iFlow session. Use this to answer questions, provide additional context, or continue a multi-turn conversation.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session ID or name to respond to",
      }),
      message: Type.String({
        description: "The message to send to the session",
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
          content: [{ type: "text", text: `Error: Session "${params.session}" not found. Use iflow_sessions to list active sessions.` }],
        };
      }

      if (session.status !== "running") {
        return {
          content: [{ type: "text", text: `Error: Session "${session.name}" is not running (status: ${session.status}).` }],
        };
      }

      // Check auto-respond cap (only applies when called by an agent, not a user command)
      const isAgentCall = !ctx.sessionKey; // heuristic: agent tool calls have no sessionKey
      if (isAgentCall) {
        session.incrementAutoRespond();
        const maxAutoResponds = pluginConfig.maxAutoResponds ?? 10;
        if (session.autoRespondCount > maxAutoResponds) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Error: Auto-respond limit reached (${maxAutoResponds} consecutive auto-responds).`,
                  `The session "${session.name}" requires user input before continuing.`,
                  `Please forward the question to the user and wait for their response.`,
                ].join("\n"),
              },
            ],
          };
        }
      }

      try {
        await session.sendMessage(params.message);

        const msgSummary = params.message.length > 60
          ? params.message.slice(0, 60) + "..."
          : params.message;

        return {
          content: [
            {
              type: "text",
              text: [
                `↩️ Message sent to session "${session.name}" [${session.id}].`,
                `   Message: "${msgSummary}"`,
                `   Use iflow_fg to stream the response, or iflow_output to read buffered output.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error sending message: ${err.message}` }],
        };
      }
    },
  };
}
