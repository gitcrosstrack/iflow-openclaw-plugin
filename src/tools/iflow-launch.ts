import { Type } from "@sinclair/typebox";
import { getSessionManager, pluginConfig, resolveOriginChannel, resolveAgentChannel } from "../shared";
import type { IFlowPluginToolContext } from "../types";

export function makeIFlowLaunchTool(ctx: IFlowPluginToolContext) {
  console.log(`[iflow-launch] Factory ctx: agentId=${ctx.agentId}, workspaceDir=${ctx.workspaceDir}, messageChannel=${ctx.messageChannel}`);

  return {
    name: "iflow_launch",
    description:
      "Launch an iFlow session in background to execute a task. Sessions are multi-turn by default — they stay open for follow-up messages via iflow_respond. Set multi_turn_disabled: true for fire-and-forget sessions. Returns a session ID and name for tracking.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task prompt to send to iFlow" }),
      name: Type.Optional(
        Type.String({
          description: "Short human-readable name for the session (kebab-case, e.g. 'fix-auth'). Auto-generated from prompt if omitted.",
        })
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory for the iFlow session (defaults to agent workspace)" })
      ),
      model: Type.Optional(
        Type.String({ description: "Model name to use (passed to iFlow)" })
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Session timeout in milliseconds (default: 300000 = 5min)" })
      ),
      max_turns: Type.Optional(
        Type.Number({ description: "Maximum number of turns before session ends" })
      ),
      system_prompt: Type.Optional(
        Type.String({ description: "Additional system prompt for the session" })
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), { description: "List of tool types to auto-approve" })
      ),
      multi_turn_disabled: Type.Optional(
        Type.Boolean({
          description: "Disable multi-turn mode. By default sessions stay open for follow-up messages. Set to true for fire-and-forget sessions.",
        })
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [Type.Literal("auto"), Type.Literal("manual"), Type.Literal("selective")],
          { description: "Permission mode for the session. Defaults to plugin config or 'auto'." }
        )
      ),
    }),
    async execute(_id: string, params: any) {
      const sm = getSessionManager();
      if (!sm) {
        return {
          content: [{ type: "text", text: "Error: SessionManager not initialized. The iflow service must be running." }],
        };
      }

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();

      try {
        // Resolve origin channel
        let ctxChannel: string | undefined;
        if (ctx.messageChannel && ctx.agentAccountId) {
          const parts = ctx.messageChannel.split("|");
          if (parts.length >= 2) {
            ctxChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
          }
        }
        if (!ctxChannel && ctx.workspaceDir) {
          ctxChannel = resolveAgentChannel(ctx.workspaceDir);
        }
        if (!ctxChannel && ctx.messageChannel && ctx.messageChannel.includes("|")) {
          ctxChannel = ctx.messageChannel;
        }

        let originChannel = resolveOriginChannel(
          { id: _id },
          ctxChannel || resolveAgentChannel(workdir)
        );
        if (originChannel === "unknown") {
          const agentChannel = resolveAgentChannel(workdir);
          if (agentChannel) originChannel = agentChannel;
        }

        const session = sm.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: params.model,
          timeout: params.timeout,
          maxTurns: params.max_turns,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          multiTurn: !params.multi_turn_disabled,
          permissionMode: params.permission_mode,
          originChannel,
          originAgentId: ctx.agentId || undefined,
        });

        const promptSummary = params.prompt.length > 80
          ? params.prompt.slice(0, 80) + "..."
          : params.prompt;

        const details = [
          `iFlow session launched successfully.`,
          `  Name: ${session.name}`,
          `  ID: ${session.id}`,
          `  Dir: ${workdir}`,
          `  Prompt: "${promptSummary}"`,
          `  Mode: ${params.multi_turn_disabled ? "single-turn (fire-and-forget)" : "multi-turn (use iflow_respond to send follow-up messages)"}`,
          ``,
          `Use iflow_sessions to check status, iflow_output to see output.`,
        ];

        return {
          content: [{ type: "text", text: details.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error launching iFlow session: ${err.message}` }],
        };
      }
    },
  };
}
