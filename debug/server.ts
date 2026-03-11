import * as http from "http";
import * as url from "url";
import { SessionManager } from "../src/session-manager";
import { NotificationRouter } from "../src/notifications";
import { setSessionManager, setNotificationRouter, setPluginConfig } from "../src/shared";

setPluginConfig({
  maxSessions: 10,
  permissionMode: "auto",
  iflowTimeout: 300_000,
  idleTimeoutMinutes: 30,
  maxAutoResponds: 10,
});

const sseClients: Set<http.ServerResponse> = new Set();

function sseEmit(event: object) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
}

const nr = new NotificationRouter((channelId: string, text: string) => {
  console.log(`[Notification] channel=${channelId} text=${text.slice(0, 80)}`);
});
setNotificationRouter(nr);

const sm = new SessionManager(10, 50);
sm.notificationRouter = nr;
setSessionManager(sm);

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function formatDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function snap(s: any) {
  return {
    id: s.id, name: s.name, status: s.status, prompt: s.prompt,
    workdir: s.workdir, startedAt: s.startedAt, completedAt: s.completedAt,
    duration: formatDur(s.duration), turnCount: s.turnCount, error: s.error,
  };
}

// HTML is stored in a separate variable to avoid any template literal conflicts
const HTML_PARTS = [
  `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"/>`,
  `<meta name="viewport" content="width=device-width,initial-scale=1"/>`,
  `<title>iFlow Debug</title><style>`,
  `*{box-sizing:border-box;margin:0;padding:0}`,
  `body{font-family:monospace;background:#0d1117;color:#c9d1d9;height:100vh;display:flex;flex-direction:column}`,
  `header{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:12px}`,
  `header h1{font-size:16px;color:#58a6ff}`,
  `.badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e}`,
  `.main{display:flex;flex:1;overflow:hidden}`,
  `.panel{display:flex;flex-direction:column;border-right:1px solid #30363d}`,
  `.panel-left{width:320px;min-width:280px}.panel-mid{width:300px;min-width:240px}.panel-right{flex:1}`,
  `.panel-title{padding:10px 14px;font-size:12px;color:#8b949e;background:#161b22;border-bottom:1px solid #30363d;text-transform:uppercase;letter-spacing:.5px}`,
  `.panel-body{flex:1;overflow-y:auto;padding:14px}`,
  `.form-group{margin-bottom:12px}`,
  `label{display:block;font-size:11px;color:#8b949e;margin-bottom:4px}`,
  `input,textarea{width:100%;background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:7px 10px;border-radius:6px;font-family:monospace;font-size:13px;outline:none}`,
  `input:focus,textarea:focus{border-color:#58a6ff}`,
  `textarea{resize:vertical;min-height:80px}`,
  `.toggle-row{display:flex;align-items:center;gap:8px;font-size:13px}`,
  `input[type=checkbox]{width:auto}`,
  `button{width:100%;padding:8px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:monospace;margin-top:4px}`,
  `button:hover{background:#2ea043}`,
  `button.danger{background:#da3633}button.danger:hover{background:#f85149}`,
  `button.secondary{background:#21262d;color:#c9d1d9;border:1px solid #30363d}button.secondary:hover{background:#30363d}`,
  `.session-item{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}`,
  `.session-item:hover,.session-item.active{border-color:#58a6ff}`,
  `.session-header{display:flex;align-items:center;gap:6px;margin-bottom:4px}`,
  `.session-name{font-size:13px;font-weight:bold;color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
  `.status-badge{font-size:10px;padding:1px 6px;border-radius:8px;white-space:nowrap}`,
  `.status-running{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb}`,
  `.status-starting{background:#9e6a0333;color:#d29922;border:1px solid #9e6a03}`,
  `.status-completed{background:#1a7f3733;color:#3fb950;border:1px solid #1a7f37}`,
  `.status-failed{background:#da363333;color:#f85149;border:1px solid #da3633}`,
  `.status-killed{background:#6e768133;color:#8b949e;border:1px solid #6e7681}`,
  `.session-meta{font-size:11px;color:#8b949e}`,
  `.session-actions{display:flex;gap:6px;margin-top:8px}`,
  `.session-actions button{margin-top:0;padding:4px 8px;font-size:11px;width:auto}`,
  `.output-tabs{display:flex;border-bottom:1px solid #30363d;background:#161b22;overflow-x:auto}`,
  `.tab{padding:8px 14px;font-size:12px;cursor:pointer;color:#8b949e;border-bottom:2px solid transparent;white-space:nowrap}`,
  `.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}`,
  `.output-area{flex:1;overflow-y:auto;padding:14px;font-size:12px;line-height:1.6}`,
  `.output-area pre{white-space:pre-wrap;word-break:break-word}`,
  `.event-output{color:#c9d1d9}.event-tool{color:#d29922}.event-waiting{color:#58a6ff;font-weight:bold}`,
  `.event-complete{color:#3fb950;font-weight:bold}.event-error{color:#f85149}.event-system{color:#8b949e;font-style:italic}`,
  `.respond-bar{padding:10px 14px;border-top:1px solid #30363d;display:flex;gap:8px}`,
  `.respond-bar input{flex:1}.respond-bar button{width:auto;margin-top:0;padding:7px 14px}`,
  `.empty{color:#8b949e;font-size:12px;text-align:center;padding:40px 0}`,
  `</style></head><body>`,
  `<header><h1>&#9889; iFlow Debug</h1>`,
  `<span class="badge" id="active-count">0 active</span>`,
  `<span class="badge" id="total-count">0 total</span></header>`,
  `<div class="main">`,
  `<div class="panel panel-left">`,
  `<div class="panel-title">Launch Session</div>`,
  `<div class="panel-body">`,
  `<div class="form-group"><label>Prompt *</label><textarea id="prompt" placeholder="e.g. 计算 1+1"></textarea></div>`,
  `<div class="form-group"><label>Working Directory</label><input id="workdir" placeholder="/Users/zdq/.openclaw/workspace"/></div>`,
  `<div class="form-group"><label>Session Name (optional)</label><input id="name" placeholder="auto-generated"/></div>`,
  `<div class="form-group"><div class="toggle-row"><input type="checkbox" id="multiTurn" checked/>`,
  `<label for="multiTurn" style="margin:0">Multi-turn</label></div></div>`,
  `<button id="btn-launch">&#9654; Launch</button>`,
  `<div id="launch-error" style="color:#f85149;font-size:12px;margin-top:8px"></div>`,
  `</div></div>`,
  `<div class="panel panel-mid"><div class="panel-title">Sessions</div>`,
  `<div class="panel-body" id="session-list"><div class="empty">No sessions yet</div></div></div>`,
  `<div class="panel panel-right" style="border-right:none">`,
  `<div class="output-tabs" id="output-tabs"></div>`,
  `<div class="output-area" id="output-area"><div class="empty">Select a session to view output</div></div>`,
  `<div class="respond-bar"><input id="respond-input" placeholder="Send follow-up message..."/>`,
  `<button id="btn-respond">Send</button></div>`,
  `</div></div>`,
  `<script>`,
  `var outputs={},activeTab=null,selectedSession=null;`,
  `function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}`,
  `function connectSSE(){`,
  `  var es=new EventSource("/api/events");`,
  `  es.onmessage=function(e){handleEvent(JSON.parse(e.data));};`,
  `  es.onerror=function(){setTimeout(connectSSE,2000);};`,
  `}`,
  `function handleEvent(ev){`,
  `  var sid=ev.sessionId;`,
  `  if(!outputs[sid])outputs[sid]=[];`,
  `  if(ev.type==="output")outputs[sid].push({type:"output",text:ev.text});`,
  `  else if(ev.type==="tool")outputs[sid].push({type:"tool",text:"Tool: "+ev.toolName+" ("+ev.status+")"});`,
  `  else if(ev.type==="waiting")outputs[sid].push({type:"waiting",text:"Waiting for input — use Respond below"});`,
  `  else if(ev.type==="complete")outputs[sid].push({type:"complete",text:"Completed (status: "+ev.status+")"});`,
  `  else if(ev.type==="error")outputs[sid].push({type:"error",text:"Error: "+ev.error});`,
  `  if(activeTab===sid)renderOutput(sid);`,
  `  if(activeTab)renderTabs(activeTab);`,
  `  refreshSessions();`,
  `}`,
  `function refreshSessions(){`,
  `  fetch("/api/sessions").then(function(r){return r.json();}).then(function(sessions){`,
  `    var active=sessions.filter(function(s){return s.status==="running"||s.status==="starting";}).length;`,
  `    document.getElementById("active-count").textContent=active+" active";`,
  `    document.getElementById("total-count").textContent=sessions.length+" total";`,
  `    var list=document.getElementById("session-list");`,
  `    if(!sessions.length){list.innerHTML='<div class="empty">No sessions yet</div>';return;}`,
  `    list.innerHTML="";`,
  `    sessions.forEach(function(s){`,
  `      var item=document.createElement("div");`,
  `      item.className="session-item"+(selectedSession===s.id?" active":"");`,
  `      var ps=s.prompt.length>50?s.prompt.slice(0,50)+"...":s.prompt;`,
  `      var errHtml=s.error?'<div class="session-meta" style="color:#f85149">'+esc(s.error)+"</div>":"";`,
  `      item.innerHTML=`,
  `        '<div class="session-header">'+`,
  `        '<span class="session-name">'+esc(s.name)+"</span>"+`,
  `        '<span class="status-badge status-'+s.status+'">'+s.status+"</span></div>"+`,
  `        '<div class="session-meta">['+s.id+"] "+s.duration+" "+s.turnCount+" turns</div>"+`,
  `        '<div class="session-meta">'+esc(ps)+"</div>"+`,
  `        errHtml+`,
  `        '<div class="session-actions">'+`,
  `        '<button class="secondary btn-out" data-id="'+s.id+'">Output</button>'+`,
  `        ((s.status==="running"||s.status==="starting")?'<button class="danger btn-kill" data-id="'+s.id+'">Kill</button>':"")+`,
  `        "</div>";`,
  `      item.addEventListener("click",function(){selectSession(s.id);});`,
  `      list.appendChild(item);`,
  `    });`,
  `    list.querySelectorAll(".btn-kill").forEach(function(b){`,
  `      b.addEventListener("click",function(e){e.stopPropagation();killSession(b.dataset.id);});`,
  `    });`,
  `    list.querySelectorAll(".btn-out").forEach(function(b){`,
  `      b.addEventListener("click",function(e){e.stopPropagation();selectSession(b.dataset.id);});`,
  `    });`,
  `  });`,
  `}`,
  `function selectSession(id){`,
  `  selectedSession=id;`,
  `  if(!outputs[id])outputs[id]=[];`,
  `  renderTabs(id);`,
  `  refreshSessions();`,
  `}`,
  `function renderTabs(sid){`,
  `  activeTab=sid;`,
  `  var el=document.getElementById("output-tabs");`,
  `  var ids=Object.keys(outputs);`,
  `  if(ids.indexOf(sid)<0)ids.push(sid);`,
  `  el.innerHTML="";`,
  `  ids.forEach(function(id){`,
  `    var t=document.createElement("div");`,
  `    t.className="tab"+(id===activeTab?" active":"");`,
  `    t.textContent=id;`,
  `    t.addEventListener("click",function(){renderTabs(id);});`,
  `    el.appendChild(t);`,
  `  });`,
  `  renderOutput(sid);`,
  `}`,
  `function renderOutput(sid){`,
  `  var area=document.getElementById("output-area");`,
  `  var evs=outputs[sid]||[];`,
  `  if(!evs.length){area.innerHTML='<div class="empty">No output yet</div>';return;}`,
  `  area.innerHTML=evs.map(function(ev){return'<pre class="event-'+ev.type+'">'+esc(ev.text)+"</pre>";}).join("");`,
  `  area.scrollTop=area.scrollHeight;`,
  `}`,
  `function launchSession(){`,
  `  var prompt=document.getElementById("prompt").value.trim();`,
  `  var workdir=document.getElementById("workdir").value.trim();`,
  `  var name=document.getElementById("name").value.trim();`,
  `  var multiTurn=document.getElementById("multiTurn").checked;`,
  `  var errEl=document.getElementById("launch-error");`,
  `  if(!prompt){errEl.textContent="Prompt is required";return;}`,
  `  errEl.textContent="";`,
  `  fetch("/api/launch",{method:"POST",headers:{"Content-Type":"application/json"},`,
  `    body:JSON.stringify({prompt:prompt,workdir:workdir||undefined,name:name||undefined,multiTurn:multiTurn})`,
  `  }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})`,
  `  .then(function(res){`,
  `    if(!res.ok){errEl.textContent=res.data.error||"Launch failed";return;}`,
  `    outputs[res.data.id]=[];`,
  `    selectSession(res.data.id);`,
  `    document.getElementById("prompt").value="";`,
  `    document.getElementById("name").value="";`,
  `    refreshSessions();`,
  `  });`,
  `}`,
  `function killSession(id){`,
  `  fetch("/api/kill",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session:id})})`,
  `  .then(function(){refreshSessions();});`,
  `}`,
  `function sendRespond(){`,
  `  var msg=document.getElementById("respond-input").value.trim();`,
  `  if(!msg||!selectedSession)return;`,
  `  fetch("/api/respond",{method:"POST",headers:{"Content-Type":"application/json"},`,
  `    body:JSON.stringify({session:selectedSession,message:msg})`,
  `  }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})`,
  `  .then(function(res){`,
  `    if(!outputs[selectedSession])outputs[selectedSession]=[];`,
  `    if(!res.ok){`,
  `      outputs[selectedSession].push({type:"error",text:"Respond error: "+(res.data.error||"unknown")});`,
  `    }else{`,
  `      document.getElementById("respond-input").value="";`,
  `      outputs[selectedSession].push({type:"system",text:"You: "+msg});`,
  `    }`,
  `    renderOutput(selectedSession);`,
  `  });`,
  `}`,
  `document.getElementById("btn-launch").addEventListener("click",launchSession);`,
  `document.getElementById("btn-respond").addEventListener("click",sendRespond);`,
  `document.getElementById("respond-input").addEventListener("keydown",function(e){if(e.key==="Enter")sendRespond();});`,
  `connectSSE();`,
  `setInterval(refreshSessions,3000);`,
  `refreshSessions();`,
  `</script></body></html>`,
];

const HTML = HTML_PARTS.join("\n");

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = 7777;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = parsed.pathname || "/";
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    json(res, sm.list("all").map(snap));
    return;
  }

  if (method === "GET" && pathname === "/api/stats") {
    const metrics = sm.getMetrics();
    json(res, { ...metrics, activeSessions: sm.list("running").length + sm.list("starting").length });
    return;
  }

  if (method === "GET" && pathname.startsWith("/api/output/")) {
    const ref = decodeURIComponent(pathname.slice("/api/output/".length));
    const session = sm.resolve(ref);
    if (!session) { json(res, { error: `Session not found` }, 404); return; }
    json(res, { id: session.id, name: session.name, status: session.status, output: session.getOutput() });
    return;
  }

  if (method === "POST" && pathname === "/api/launch") {
    try {
      const body = await readBody(req);
      if (!body.prompt) { json(res, { error: "prompt is required" }, 400); return; }
      const session = sm.spawn({
        prompt: body.prompt,
        workdir: body.workdir || process.cwd(),
        name: body.name,
        multiTurn: body.multiTurn !== false,
        permissionMode: "auto",
      });
      session.onOutput = (text) => sseEmit({ type: "output", sessionId: session.id, text });
      session.onToolUse = (toolName, status) => sseEmit({ type: "tool", sessionId: session.id, toolName, status });
      session.onWaitingForInput = () => sseEmit({ type: "waiting", sessionId: session.id });
      session.onComplete = () => {
        sseEmit({ type: "complete", sessionId: session.id, status: session.status });
        if (session.error) sseEmit({ type: "error", sessionId: session.id, error: session.error });
      };
      json(res, snap(session), 201);
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/respond") {
    try {
      const body = await readBody(req);
      if (!body.session || !body.message) { json(res, { error: "session and message required" }, 400); return; }
      const session = sm.resolve(body.session);
      if (!session) { json(res, { error: "Session not found" }, 404); return; }
      if (session.status !== "running") { json(res, { error: `Session not running (${session.status})` }, 400); return; }
      await session.sendMessage(body.message);
      json(res, { success: true });
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/kill") {
    try {
      const body = await readBody(req);
      if (!body.session) { json(res, { error: "session required" }, 400); return; }
      const session = sm.resolve(body.session);
      if (!session) { json(res, { error: "Session not found" }, 404); return; }
      json(res, { success: sm.kill(session.id) });
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  json(res, { error: "Not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n⚡ iFlow Debug Server running at http://127.0.0.1:${PORT}\n`);
});

process.on("SIGINT", () => {
  sm.killAll();
  server.close();
  process.exit(0);
});
