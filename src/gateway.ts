import { getSessionManager, formatDuration } from "./shared";

/**
 * Register Gateway RPC methods for iFlow plugin.
 * These allow external systems to interact with iFlow sessions via the OpenClaw gateway.
 */
export function registerGatewayMethods(api: any): void {
  // iflow.launch — Launch a new session via RPC
  api.registerRpcMethod?.("iflow.launch", async (params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const { prompt, name, workdir, model, timeout, maxTurns, systemPrompt, multiTurn } = params;
    if (!prompt) throw new Error("prompt is required");

    const session = sm.spawn({
      prompt,
      name,
      workdir: workdir || process.cwd(),
      model,
      timeout,
      maxTurns,
      systemPrompt,
      multiTurn: multiTurn !== false,
    });

    return {
      id: session.id,
      name: session.name,
      status: session.status,
      workdir: session.workdir,
    };
  });

  // iflow.sessions — List sessions via RPC
  api.registerRpcMethod?.("iflow.sessions", async (params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const filter = params?.filter ?? "all";
    const sessions = sm.list(filter);

    return sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      workdir: s.workdir,
      prompt: s.prompt,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      duration: formatDuration(s.duration),
      turnCount: s.turnCount,
      error: s.error,
    }));
  });

  // iflow.kill — Terminate a session via RPC
  api.registerRpcMethod?.("iflow.kill", async (params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const ref = params?.session;
    if (!ref) throw new Error("session is required");

    const session = sm.resolve(ref);
    if (!session) throw new Error(`Session "${ref}" not found`);

    const killed = sm.kill(session.id);
    return { success: killed, id: session.id, name: session.name };
  });

  // iflow.output — Read session output via RPC
  api.registerRpcMethod?.("iflow.output", async (params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const ref = params?.session;
    if (!ref) throw new Error("session is required");

    const session = sm.resolve(ref);
    if (!session) {
      const persisted = sm.getPersistedSession(ref);
      if (persisted) {
        return { id: persisted.sessionId, name: persisted.name, status: persisted.status, output: [] };
      }
      throw new Error(`Session "${ref}" not found`);
    }

    const lines = params?.full ? undefined : (params?.lines ?? 50);
    const output = session.getOutput(lines);

    return {
      id: session.id,
      name: session.name,
      status: session.status,
      output,
    };
  });

  // iflow.respond — Send a message to a session via RPC
  api.registerRpcMethod?.("iflow.respond", async (params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const ref = params?.session;
    const message = params?.message;
    if (!ref) throw new Error("session is required");
    if (!message) throw new Error("message is required");

    const session = sm.resolve(ref);
    if (!session) throw new Error(`Session "${ref}" not found`);
    if (session.status !== "running") throw new Error(`Session "${session.name}" is not running (status: ${session.status})`);

    await session.sendMessage(message);
    return { success: true, id: session.id, name: session.name };
  });

  // iflow.stats — Get usage statistics via RPC
  api.registerRpcMethod?.("iflow.stats", async (_params: any) => {
    const sm = getSessionManager();
    if (!sm) throw new Error("SessionManager not initialized");

    const metrics = sm.getMetrics();
    const activeSessions = sm.list("running").length + sm.list("starting").length;

    return {
      totalSessions: metrics.totalSessions,
      activeSessions,
      sessionsByStatus: metrics.sessionsByStatus,
      totalDurationMs: metrics.totalDurationMs,
      averageDurationMs: metrics.sessionsWithDuration > 0
        ? Math.floor(metrics.totalDurationMs / metrics.sessionsWithDuration)
        : 0,
      mostExpensive: metrics.mostExpensive,
    };
  });
}
