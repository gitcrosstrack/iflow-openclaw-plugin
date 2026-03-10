import { getSessionManager, pluginConfig, resolveOriginChannel, resolveAgentChannel } from "../shared";
import { generateSessionName } from "../shared";

/**
 * /iflow <prompt> — Launch a new iFlow session
 * /iflow --name <name> <prompt>
 */
export function registerIFlowCommand(api: any) {
  api.registerCommand({
    name: "iflow",
    description: "Launch a new iFlow session. Usage: /iflow [--name <name>] <prompt>",
    async execute(args: string, ctx: any) {
      const sm = getSessionManager();
      if (!sm) {
        return "Error: SessionManager not initialized.";
      }

      let name: string | undefined;
      let prompt = args.trim();

      // Parse --name flag
      const nameMatch = prompt.match(/^--name\s+(\S+)\s+([\s\S]+)$/);
      if (nameMatch) {
        name = nameMatch[1];
        prompt = nameMatch[2].trim();
      }

      if (!prompt) {
        return [
          "Usage: /iflow [--name <name>] <prompt>",
          "",
          "Examples:",
          "  /iflow Fix the authentication bug in src/auth.ts",
          "  /iflow --name fix-auth Fix the authentication bug",
        ].join("\n");
      }

      const workdir = ctx?.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const channelId = ctx?.messageChannel || "unknown";

      let originChannel = resolveOriginChannel({ id: "cmd" }, resolveAgentChannel(workdir) || channelId);

      try {
        const session = sm.spawn({
          prompt,
          name,
          workdir,
          multiTurn: true,
          originChannel,
          originAgentId: ctx?.agentId,
        });

        return [
          `↩️ iFlow session launched!`,
          `  Name: ${session.name}`,
          `  ID: ${session.id}`,
          `  Dir: ${workdir}`,
          ``,
          `Use /iflow_sessions to check status, /iflow_fg ${session.name} to stream output.`,
        ].join("\n");
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  });
}
