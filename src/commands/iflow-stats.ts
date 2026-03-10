import { getSessionManager, formatDuration } from "../shared";

/**
 * /iflow_stats — Show usage statistics
 */
export function registerIFlowStatsCommand(api: any) {
  api.registerCommand({
    name: "iflow_stats",
    description: "Show iFlow session usage statistics.",
    async execute(_args: string, _ctx: any) {
      const sm = getSessionManager();
      if (!sm) return "Error: SessionManager not initialized.";

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
          `Notable Session`,
          `  Name:   ${metrics.mostExpensive.name} [${metrics.mostExpensive.id}]`,
          `  Prompt: "${metrics.mostExpensive.prompt}"`,
        );
      }

      return lines.join("\n");
    },
  });
}
