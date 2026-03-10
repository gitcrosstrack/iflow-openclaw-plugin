import { getSessionManager, formatDuration } from "../shared";

/**
 * /iflow_sessions [filter] — List all iFlow sessions
 */
export function registerIFlowSessionsCommand(api: any) {
  api.registerCommand({
    name: "iflow_sessions",
    description: "List all iFlow sessions. Usage: /iflow_sessions [all|running|completed|failed|killed]",
    async execute(args: string, _ctx: any) {
      const sm = getSessionManager();
      if (!sm) return "Error: SessionManager not initialized.";

      const filter = (args.trim() || "all") as any;
      const sessions = sm.list(filter);

      if (sessions.length === 0) {
        return filter === "all"
          ? "No sessions found. Use /iflow to start a new session."
          : `No sessions with status "${filter}".`;
      }

      const lines: string[] = [`iFlow Sessions (${sessions.length}):`];
      for (const session of sessions) {
        const emoji = { starting: "🔄", running: "▶️", completed: "✅", failed: "❌", killed: "⛔" }[session.status] ?? "❓";
        const duration = formatDuration(session.duration);
        const promptSummary = session.prompt.length > 50 ? session.prompt.slice(0, 50) + "..." : session.prompt;
        const fgIndicator = session.foregroundChannels.size > 0 ? " 📺" : "";
        lines.push(
          ``,
          `${emoji} ${session.name} [${session.id}]${fgIndicator}`,
          `   ${session.status} | ${duration}`,
          `   "${promptSummary}"`,
          ...(session.error ? [`   ⚠️ ${session.error}`] : []),
        );
      }

      return lines.join("\n");
    },
  });
}
