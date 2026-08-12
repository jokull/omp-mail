// omp-mail extension — inter-session mail for omp.
// Drop into ~/.omp/agent/extensions/ (or load with `omp --extension`).
// Sends/receives mail across omp processes via a singleton daemon
// (~/.omp/mail-daemon.sock). Sessions are addressed by session id, an
// auto-generated slug (from the session title), or a user alias (/mail alias).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const SOCK = join(HOME, ".omp", "mail-daemon.sock");
const MAIL_DIR = join(HOME, ".omp", "mail");
const DAEMON_PATH = process.env.OMP_MAIL_DAEMON ?? fileURLToPath(new URL("./daemon.mjs", import.meta.url));

interface MailMsg {
  id: string;
  seq: number;
  from: string;
  fromName?: string;
  fromSlug?: string;
  to: string;
  subject: string;
  body: string;
  ts: number;
}

export default function ompMail(pi: ExtensionAPI) {
  const z = pi.zod;

  let sessionId = "";
  let name = "";
  let slug = "";
  let aliases: string[] = [];
  let ctxRef: any = null;
  let sock: Socket | null = null;
  let connected = false;
  let buffer = "";
  let injected = new Set<string>();
  let lastSpawn = 0;
  let latestAgents: any[] = [];
  const pending = new Map<string, (v: any) => void>();

  const log = (msg: string) => { try { pi.logger?.debug(`[omp-mail] ${msg}`); } catch {} };

  const myMailbox = () => join(MAIL_DIR, `${sessionId}.jsonl`);
  const cursorPath = () => join(MAIL_DIR, `${sessionId}.cursor`);

  function readCursor(): number {
    try { return Number(readFileSync(cursorPath(), "utf8")) || 0; } catch { return 0; }
  }
  function writeCursor(seq: number) { try { writeFileSync(cursorPath(), String(seq)); } catch {} }

  // Rapid-exchange detection: >=3 messages with the same peer in 60s is a
  // ping-pong loop, not work. Suppressed deliveries become context, not turns.
  const peerRecent = new Map<string, number[]>();
  function noteExchange(peer: string) {
    const now = Date.now();
    const arr = (peerRecent.get(peer) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    peerRecent.set(peer, arr);
  }
  function inPingPong(peer: string): boolean {
    const now = Date.now();
    const arr = (peerRecent.get(peer) ?? []).filter((t) => now - t < 60_000);
    peerRecent.set(peer, arr);
    return arr.length >= 3;
  }

  async function deliver(m: MailMsg) {
    if (injected.has(m.id)) return;
    const cursor = readCursor();
    if (m.seq <= cursor) {
      // Already delivered in a previous process life — never re-act on it.
      injected.add(m.id);
      return;
    }
    injected.add(m.id);
    noteExchange(m.from);
    const from = m.fromName ?? m.from;
    const addr = m.fromSlug ?? m.from;
    const header = `${from}${m.fromSlug && m.fromSlug !== from ? ` (slug ${m.fromSlug})` : ""}`;
    const text =
      `📬 Mail from ${header}: ${m.subject}\n\n${m.body}\n\n` +
      `Reply with mail_send({to: "${addr}", subject: ..., body: ...}) only if a response is actually wanted — new work, a question, or a blocker. Confirmations and closings need no reply.`;
    try {
      if (inPingPong(m.from)) {
        // Loop suppression: deliver as hidden context for the next user prompt
        // instead of starting an autonomous turn.
        log(`loop suppression: ${m.from} (${m.subject}) -> context`);
        await pi.sendMessage({ content: text, display: false, attribution: "user" }, { deliverAs: "nextTurn" });
      } else {
        await pi.sendUserMessage(text);
      }
      // Durable cursor at delivery time — a kill/resume must not replay seen mail.
      if (m.seq > readCursor()) writeCursor(m.seq);
    } catch (e) {
      log(`deliver failed: ${String(e)}`);
    }
  }

  function syncMailbox() {
    if (!sessionId) return;
    const path = myMailbox();
    if (!existsSync(path)) return;
    let cursor = readCursor();
    let max = cursor;
    let count = 0;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as MailMsg;
          if (m.seq > cursor) { void deliver(m); max = Math.max(max, m.seq); count++; }
        } catch {}
      }
    } catch (e) { log(`sync failed: ${String(e)}`); }
    if (max > cursor) { writeCursor(max); log(`synced ${count} new mail(s) (cursor ${cursor} -> ${max})`); }
  }

  function ensureDaemon() {
    const now = Date.now();
    if (now - lastSpawn < 15_000) return;
    lastSpawn = now;
    try {
      const child = spawn("node", [DAEMON_PATH], { detached: true, stdio: "ignore" });
      child.unref();
      log(`spawned daemon (pid ${child.pid})`);
    } catch (e) { log(`spawn failed: ${String(e)}`); }
  }

  function teardownSocket() {
    connected = false;
    try { sock?.destroy(); } catch {}
    sock = null;
    if (ctxRef) ctxRef.setTimeout(() => connectLoop(), 2000);
  }

  function sendFrame(obj: unknown): boolean {
    if (!connected || !sock || sock.destroyed) return false;
    try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  function handleFrame(f: any) {
    if (f.reqId && pending.has(f.reqId)) {
      const resolve = pending.get(f.reqId)!;
      pending.delete(f.reqId);
      resolve(f);
      return;
    }
    switch (f.type) {
      case "mail": void deliver(f as MailMsg); break;
      case "agents": latestAgents = f.agents ?? []; break;
      case "ok":
        if (f.op === "register") { slug = f.slug ?? slug; log(`registered slug=${slug}`); }
        if (f.op === "alias") { aliases = f.aliases ?? aliases; }
        log(`daemon ok: ${f.op}`);
        break;
      case "error": log(`daemon error: ${f.message}`); break;
    }
  }

  function connectLoop() {
    if (connected || !ctxRef) return;
    const s = connect(SOCK);
    sock = s;
    s.on("connect", () => {
      connected = true;
      buffer = "";
      log("connected to daemon");
      sendFrame({ type: "register", sessionId, pid: process.pid, name, cwd: ctxRef.cwd ?? "" });
    });
    s.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try { handleFrame(JSON.parse(line)); } catch (e) { log(`bad frame: ${String(e)}`); }
      }
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      log(`socket error: ${e.code ?? e.message}`);
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT") ensureDaemon();
      teardownSocket();
    });
    s.on("close", () => { teardownSocket(); });
  }

  function request(obj: Record<string, unknown>, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      pending.set(reqId, resolve);
      if (!sendFrame({ ...obj, reqId })) {
        pending.delete(reqId);
        resolve(null);
        return;
      }
      ctxRef?.setTimeout(() => { if (pending.delete(reqId)) resolve(null); }, timeoutMs);
    });
  }

  async function sendMail(to: string, subject: string, body: string): Promise<{ ok: boolean; note?: string }> {
    if (connected) {
      const res = await request({ type: "send", to, subject, body }, 3000);
      if (res?.type === "ok") {
        if (res.toId) noteExchange(res.toId);
        return { ok: true, note: res.live > 0 ? "delivered live" : "delivered (offline — inbox on resume)" };
      }
      if (res?.type === "error") return { ok: false, note: res.message };
      // request timed out — fall through to degraded write
    }
    // Degraded: daemon unreachable — append directly to recipient mailbox(es).
    try {
      mkdirSync(MAIL_DIR, { recursive: true });
      const ids = to === "all"
        ? readdirSync(MAIL_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6))
        : [to];
      if (!ids.length) return { ok: false, note: "no recipients" };
      for (const id of ids) {
        const path = join(MAIL_DIR, `${id}.jsonl`);
        const prev = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
        const msg: MailMsg = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          seq: prev + 1,
          from: sessionId,
          fromName: name,
          to: id,
          subject,
          body,
          ts: Date.now(),
        };
        appendFileSync(path, JSON.stringify(msg) + "\n");
      }
      return { ok: true, note: "delivered (daemon down, direct write)" };
    } catch (e) {
      return { ok: false, note: String(e) };
    }
  }

  function formatAgents(): string {
    if (!latestAgents.length) return "No agents registered.";
    return latestAgents
      .map((a) => {
        const addr = [a.slug, ...(a.aliases ?? [])].filter(Boolean).join(", ");
        return `${a.alive ? "●" : "○"} ${a.sessionId}  ${addr || "-"}  ${a.name}  ${a.cwd}  ${a.alive ? "live" : "offline"}`;
      })
      .join("\n");
  }

  // Re-register with current identity (session id may change on switch).
  function refreshIdentity(notify = false) {
    if (!ctxRef) return;
    try { sessionId = ctxRef.sessionManager.getSessionId(); } catch { return; }
    name = pi.getSessionName?.() ?? (basename(ctxRef.cwd ?? "") || sessionId);
    if (connected) {
      sendFrame({ type: "register", sessionId, pid: process.pid, name, cwd: ctxRef.cwd ?? "" });
    }
    if (notify) ctxRef.ui.notify(`omp-mail: ${sessionId}${slug ? " · " + slug : ""}`, "info");
  }

  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    refreshIdentity(true);
    log(`session_start id=${sessionId} name=${name}`);
    mkdirSync(MAIL_DIR, { recursive: true });
    if (!existsSync(SOCK)) ensureDaemon();
    connectLoop();
    ctx.setTimeout(() => syncMailbox(), 1500);
    ctx.setInterval(() => syncMailbox(), 2000);
  });

  pi.on("session_shutdown", () => {
    if (connected) sendFrame({ type: "unregister", sessionId });
    ctxRef = null;
    teardownSocket();
  });

  pi.on("session_switch", () => {
    refreshIdentity();
  });

  // Refresh slug when the model auto-titles the session from content/task.
  pi.on("turn_end", () => {
    if (!ctxRef) return;
    const current = pi.getSessionName?.() ?? "";
    if (current && current !== name) {
      name = current;
      log(`session titled: ${name}`);
      if (connected) sendFrame({ type: "meta", name, keepSlug: false });
    }
  });

  pi.registerTool({
    name: "mail_send",
    label: "Mail Send",
    description:
      "Send a mail message to another omp session. `to` accepts slug, alias, session id, or \"all\". " +
      "Arguments are a JSON object {to, subject, body} — write valid single-line JSON (escape newlines as \\n). " +
      "Keep `body` short: the recipient can read repo files, so point to them instead of pasting. " +
      "Discover recipient addresses with mail_agents.",
    parameters: z.object({
      to: z.string().describe("Recipient: session id, slug, alias, or \"all\""),
      subject: z.string().describe("Short subject line"),
      body: z.string().describe("Message body"),
    }),
    async execute(_id, params: { to: string; subject: string; body: string }) {
      if (!sessionId) return { content: [{ type: "text", text: "Error: no session id." }], isError: true };
      const r = await sendMail(params.to, params.subject, params.body);
      if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.note}` }], isError: true };
      return {
        content: [{ type: "text", text: `Mail sent to ${params.to}: ${params.subject}` }],
        details: { to: params.to, subject: params.subject, note: r.note },
      };
    },
  });

  pi.registerTool({
    name: "mail_agents",
    label: "Mail Agents",
    description: "List omp sessions registered with the mail daemon: sessionId, slug, aliases, name, cwd, live/offline.",
    parameters: z.object({}),
    async execute() {
      if (!connected) return { content: [{ type: "text", text: "Mail daemon not connected." }] };
      const res = await request({ type: "list" }, 2000);
      if (!res?.agents) return { content: [{ type: "text", text: "No response from daemon." }] };
      latestAgents = res.agents;
      return { content: [{ type: "text", text: formatAgents() }] };
    },
  });

  pi.registerCommand("mail", {
    description: "omp-mail: /mail <to> <subject> <body> | whoami | agents | alias <name> | inbox | test",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const notify = (text: string) => ctx.ui.notify(text, "info");
      if (!cmd) return notify("omp-mail: /mail <to> <subject> <body> | whoami | agents | alias <name> | inbox | test");
      if (!["whoami", "agents", "alias", "send", "inbox", "test"].includes(cmd)) {
        // implicit send: /mail <to> <subject> <body...>
        const [to, subject, ...bodyParts] = [cmd, ...rest];
        if (!to || !subject) return notify("usage: /mail <to> <subject> <body>");
        const r = await sendMail(to, subject, bodyParts.join(" ") || "(empty body)");
        notify(
          r.ok
            ? `→ ${to} · ${subject} · ${r.note ?? "delivered live"}`
            : `✗ ${to}: ${r.note}`,
        );
        return;
      }
      switch (cmd) {
        case "whoami":
          notify(`you are "${name}" · ${sessionId}${slug ? ` · slug ${slug}` : ""}${aliases.length ? ` · alias ${aliases.join(",")}` : ""}`);
          break;
        case "alias": {
          const want = rest[0];
          if (!want) return notify("usage: /mail alias <name>  (or /mail alias - to clear)");
          const res = await request({ type: "alias", set: want !== "-", name: want === "-" ? "" : want }, 2000);
          aliases = res?.aliases ?? aliases;
          notify(res?.type === "ok" ? `alias: ${aliases.join(", ") || "(none)"}` : `alias error: ${res?.message ?? "no response"}`);
          break;
        }
        case "agents": {
          if (!connected) return notify("daemon not connected");
          const res = await request({ type: "list" }, 2000);
          latestAgents = res?.agents ?? latestAgents;
          notify(formatAgents());
          break;
        }
        case "send": {
          const [to, subject, ...bodyParts] = rest;
          if (!to || !subject) return notify("usage: /mail send <to> <subject> <body>");
          const r = await sendMail(to, subject, bodyParts.join(" ") || "(empty body)");
          notify(
            r.ok
              ? `→ ${to} · ${subject} · ${r.note ?? "delivered live"}`
              : `✗ ${to}: ${r.note}`,
          );
          break;
        }
        case "inbox": {
          const path = myMailbox();
          if (!existsSync(path)) return notify("inbox empty");
          const msgs = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).slice(-8);
          if (!msgs.length) return notify("inbox empty");
          notify(msgs.map((m) => `#${m.seq} ${m.fromName ?? m.from}: ${m.subject}`).join("\n"));
          break;
        }
        case "test": {
          const r = await sendMail(sessionId, "mail test", "self-test from " + name);
          notify(r.ok ? `test mail sent (${r.note ?? "delivered"})` : `test failed: ${r.note}`);
          break;
        }
      }
    },
  });
}
