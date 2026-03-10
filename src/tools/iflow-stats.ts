import { Type } from "@sinclair/typebox";
import { getSessionManager, formatDuration } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowStatsTool(_ctx: IFlowPluginToolContext) {
  return {
    name: "iflow_stats",
    description: "Show usage metrics for iFlow sessions: total count, duration, and breakdown by status.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      const sm = getSessionManager();
      if (!sm) {
        return {
          content: [{ type: "text", text: "Error: SessionManager not initialized." }],
        };
      }

      const metrics = sm.getMetrics();
      const activeSessions = sm.list("running").length + sm.list("starting").length;

      const avgDuration =
        metrics.sessionsWithDuration > 0
          ? formatDuration(Math.floor(metrics.totalDurationMs / metrics.sessionsWithDuration))
          : "N/A";

      const lines = [
        `📊 iFlow Session Statistics`,
        ``,
        `Sessions`,
        `  Total launched:  ${metrics.totalSessions}`,
        `  Active now:      ${activeSessions}`,
        `  Completed:       ${metrics.sessionsByStatus.completed}`,
        `  Failed:          ${metrics.sessionsByStatus.failed}`,
        `  Killed:          ${metrics.sessionsByStatus.killed}`,
        ``,
        `Duration`,
        `  Total time:      ${formatDuration(metrics.totalDurationMs)}`,
        `  Average:         ${avgDuration}`,
      ];

      if (metrics.mostExpensive) {
        lines.push(
          ``,
          `Longest Session`,
          `  Name:   ${metrics.mostExpensive.name} [${metrics.mostExpensive.id}]`,
          `  Prompt: "${metrics.mostExpensive.prompt}"`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  };
}
