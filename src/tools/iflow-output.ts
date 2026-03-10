import { Type } from "@sinclair/typebox";
import { getSessionManager } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowOutputTool(_ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_output",
    description:
      "Read buffered output from an iFlow session. Returns the last N lines of output (default: 50). Use full=true to get all buffered output.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session ID or name",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of lines to return from the end of the buffer (default: 50)",
        })
      ),
      full: Type.Optional(
        Type.Boolean({
          description: "Return all buffered output (up to 200 lines). Overrides 'lines' parameter.",
        })
      ),
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
        // Also check persisted sessions
        const persisted = sm.getPersistedSession(params.session);
        if (persisted) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Session "${persisted.name}" [${persisted.sessionId}] has completed (status: ${persisted.status}).`,
                  `Output buffer is no longer available for completed sessions.`,
                  `Use iflow_resume to restart the session.`,
                ].join("\n"),
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: `Error: Session "${params.session}" not found. Use iflow_sessions to list sessions.` }],
        };
      }

      const numLines = params.full ? undefined : (params.lines ?? 50);
      const output = session.getOutput(numLines);

      if (output.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Session "${session.name}" [${session.id}] — status: ${session.status}`,
                `No output yet.`,
              ].join("\n"),
            },
          ],
        };
      }

      const header = [
        `Session "${session.name}" [${session.id}] — status: ${session.status}`,
        `--- Output (${output.length} entries) ---`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: header + "\n" + output.join("\n"),
          },
        ],
      };
    },
  };
}
