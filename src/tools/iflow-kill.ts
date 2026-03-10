import { Type } from "@sinclair/typebox";
import { getSessionManager } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowKillTool(_ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_kill",
    description: "Terminate a running iFlow session.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session ID or name to terminate",
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

      if (session.status !== "running" && session.status !== "starting") {
        return {
          content: [
            {
              type: "text",
              text: `Session "${session.name}" is already ${session.status}. Nothing to kill.`,
            },
          ],
        };
      }

      const killed = sm.kill(session.id);
      if (!killed) {
        return {
          content: [{ type: "text", text: `Error: Failed to kill session "${session.name}".` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `⛔ Session "${session.name}" [${session.id}] has been terminated.`,
          },
        ],
      };
    },
  };
}
