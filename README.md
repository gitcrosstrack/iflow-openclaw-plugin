# OpenClaw plugin to orchestrate iFlow

Orchestrate iFlow sessions as managed background processes from any OpenClaw channel.

Launch, monitor, and interact with multiple iFlow sessions directly from DingTalk, or any OpenClaw-supported platform — without leaving your chat interface.

> **Acknowledgement**: This plugin is inspired by and based on [openclaw-claude-code-plugin](https://github.com/alizarion/openclaw-claude-code-plugin) by [@alizarion](https://github.com/alizarion). The architecture, session management model, and foreground/background design are adapted from that project, with iFlow SDK replacing the Claude Code SDK as the underlying AI engine.

---

## Quick Start

### 1. Install the DingTalk channel plugin

```bash
openclaw plugins install @soimy/dingtalk
openclaw gateway restart
```

### 2. Install this plugin

**Option A — Install from GitHub (recommended)**

```bash
openclaw plugins install github:gitcrosstrack/iflow-openclaw-plugin
openclaw gateway restart
```

**Option B — Install locally (for development)**

```bash
git clone https://github.com/gitcrosstrack/iflow-openclaw-plugin.git
cd iflow-openclaw-plugin
npm install
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

### 3. Configure DingTalk channel + plugin notifications

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk", "openclaw-iflow-plugin"]
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "robotCode": "dingxxxxxx",
      "corpId": "dingxxxxxx",
      "agentId": "123456789",
      "dmPolicy": "open",
      "messageType": "markdown"
    }
  },
  "plugins": {
    "entries": {
      "openclaw-iflow-plugin": {
        "enabled": true,
        "config": {
          "fallbackChannel": "dingtalk|your-dingtalk-userid",
          "maxSessions": 5
        }
      }
    }
  }
}
```

> `your-dingtalk-userid` 是你的钉钉 userId，可在钉钉开发者后台或机器人收到消息的日志中获取。

### 4. Launch your first session

```
/iflow Fix the bug in auth.ts
```

---

## Features

- **Multi-session management** — Run multiple concurrent iFlow sessions, each with a unique ID and human-readable name
- **Foreground / background model** — Sessions run in background by default; bring any to foreground to stream output in real time, with catchup of missed output
- **Real-time notifications** — Get notified on completion, failure, or when iFlow is waiting for input
- **Multi-turn conversations** — Send follow-up messages to a running session
- **Session resume** — Resume any completed session or restart it with a new prompt
- **Multi-agent support** — Route notifications to the correct agent/chat via workspace-based channel mapping
- **Automatic cleanup** — Completed sessions garbage-collected after 1 hour

---

## Tools

| Tool | Description |
|------|-------------|
| `iflow_launch` | Start a new iFlow session in background |
| `iflow_respond` | Send a follow-up message to a running session |
| `iflow_fg` | Bring a session to foreground — stream output in real time |
| `iflow_bg` | Send a session back to background — stop streaming |
| `iflow_kill` | Terminate a running session |
| `iflow_output` | Read buffered output from a session |
| `iflow_sessions` | List all sessions with status and progress |
| `iflow_stats` | Show usage metrics (counts, durations) |

All tools are also available as **chat commands** (`/iflow`, `/iflow_fg`, etc.) and as **gateway RPC methods**.

---

## Quick Usage

```bash
# Launch a session
/iflow Fix the authentication bug in src/auth.ts
/iflow --name fix-auth Fix the authentication bug

# Monitor
/iflow_sessions
/iflow_fg fix-auth
/iflow_bg fix-auth

# Interact
/iflow_respond fix-auth Also add unit tests

# Lifecycle
/iflow_kill fix-auth
/iflow_resume fix-auth Add error handling
/iflow_stats
```

---

## Notifications

The plugin sends real-time notifications to your chat based on session lifecycle events:

| Emoji | Event | Description |
|-------|-------|-------------|
| ↩️ | Launched | Session started successfully |
| 🔔 | iFlow asks | Session is waiting for user input — includes output preview |
| ↩️ | Responded | Follow-up message delivered to session |
| ✅ | Completed | Session finished successfully |
| ❌ | Failed | Session encountered an error |
| ⛔ | Killed | Session was manually terminated |

Foreground sessions stream full output in real time. Background sessions only send lifecycle notifications.

---

## Configuration

Set values in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-iflow-plugin"].config`.

### Parameters

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentChannels` | `object` | — | Map workdir paths → notification channels |
| `fallbackChannel` | `string` | — | Default channel when no workspace match found |
| `maxSessions` | `number` | `5` | Maximum concurrent sessions |
| `maxAutoResponds` | `number` | `10` | Max consecutive auto-responds before requiring user input |
| `iflowTimeout` | `number` | `300000` | Default iFlow session timeout in milliseconds |
| `permissionMode` | `string` | `"auto"` | `"auto"` / `"manual"` / `"selective"` |
| `skipSafetyChecks` | `boolean` | `false` | Skip pre-launch safety guards (for dev/testing only) |
| `safetyNetIdleSeconds` | `number` | `600` | Seconds of no output before session is considered waiting for input |

### Example

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-iflow-plugin": {
        "enabled": true,
        "config": {
          "maxSessions": 3,
          "iflowTimeout": 600000,
          "permissionMode": "auto",
          "fallbackChannel": "dingtalk|your-dingtalk-userid",
          "agentChannels": {
            "/home/user/agent-main": "dingtalk|your-dingtalk-userid",
            "/home/user/agent-seo": "dingtalk|another-dingtalk-userid"
          }
        }
      }
    }
  }
}
```

---

## iFlow SDK

This plugin uses the [iFlow TypeScript SDK](https://platform.iflow.cn/cli/sdk/sdk-typescript) (`@iflow-ai/iflow-cli-sdk`) to interact with iFlow CLI.

### System Requirements

- Node.js 22.0 or higher
- iFlow CLI 0.2.24 or higher
- OpenClaw gateway

### iFlow SDK Message Types

| Message Type | Description |
|---|---|
| `ASSISTANT` | AI assistant text response (`chunk.text`) |
| `TOOL_CALL` | Tool execution (`toolName`, `status`) |
| `PLAN` | Structured task plan (`entries`) |
| `TASK_FINISH` | Task completion signal (`stopReason`) |
| `ERROR` | Error message (`code`, `message`) |

---

## Gateway RPC Methods

| Method | Description |
|--------|-------------|
| `iflow.launch` | Launch a session |
| `iflow.sessions` | List sessions |
| `iflow.kill` | Terminate a session |
| `iflow.output` | Read session output |
| `iflow.respond` | Send a message to a session |
| `iflow.stats` | Get usage statistics |

---

## Architecture

```
index.ts                    ← Plugin entry point (register tools, commands, service)
src/
  types.ts                  ← Core type definitions
  shared.ts                 ← Global singletons & utility functions
  session.ts                ← Single iFlow session lifecycle (IFlowClient wrapper)
  session-manager.ts        ← Multi-session management, notifications, IPC wake
  notifications.ts          ← NotificationRouter (foreground streaming, debounce)
  gateway.ts                ← Gateway RPC method registration
  tools/                    ← 8 OpenClaw tools (factory pattern)
    iflow-launch.ts
    iflow-respond.ts
    iflow-fg.ts
    iflow-bg.ts
    iflow-kill.ts
    iflow-output.ts
    iflow-sessions.ts
    iflow-stats.ts
  commands/                 ← 8 chat commands
    iflow.ts
    iflow-sessions.ts
    iflow-kill.ts
    iflow-fg.ts
    iflow-bg.ts
    iflow-respond.ts
    iflow-stats.ts
    iflow-resume.ts
```

---

## License

MIT
