import { Type } from "@sinclair/typebox";
import { getSessionManager, formatDuration } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowSessionsTool(_ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_sessions",
    description: "List all iFlow sessions with their status, progress, and duration.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("running"),
            Type.Literal("starting"),
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("killed"),
          ],
          { description: "Filter sessions by status (default: all)" }
        )
      ),
    }),
    async execute(_id: string, params: any) {
      const sm = getSessionManager();
      if (!sm) {
        return {
          content: [{ type: "text", text: "Error: SessionManager not initialized." }],
        };
      }

      const filter = params.filter ?? "all";
      const sessions = sm.list(filter);

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: filter === "all"
                ? "No sessions found. Use iflow_launch to start a new session."
                : `No sessions with status "${filter}".`,
            },
          ],
        };
      }

      const lines: string[] = [`iFlow Sessions (${sessions.length} total):`];

      for (const session of sessions) {
        const statusEmoji = {
          starting: "🔄",
          running: "▶️",
          completed: "✅",
          failed: "❌",
          killed: "⛔",
        }[session.status] ?? "❓";

        const duration = formatDuration(session.duration);
        const promptSummary = session.prompt.length > 50
          ? session.prompt.slice(0, 50) + "..."
          : session.prompt;

        const fgIndicator = session.foregroundChannels.size > 0 ? " 📺" : "";
        const turnInfo = session.turnCount > 0 ? ` (${session.turnCount} turns)` : "";

        lines.push(
          ``,
          `${statusEmoji} ${session.name} [${session.id}]${fgIndicator}`,
          `   Status: ${session.status}${turnInfo} | Duration: ${duration}`,
          `   Dir: ${session.workdir}`,
          `   Prompt: "${promptSummary}"`,
          ...(session.error ? [`   Error: ${session.error}`] : []),
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  };
}
