#!/usr/bin/env node
// omp-mail daemon — singleton inter-session mailbox for omp.
// Newline-delimited JSON over Unix socket ~/.omp/mail-daemon.sock
// Frames: register | meta | alias | send | list | inbox
import { createServer, connect as netConnect } from "node:net";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const HOME = homedir();
const SOCK = join(HOME, ".omp", "mail-daemon.sock");
const MAIL_DIR = join(HOME, ".omp", "mail");
const REGISTRY = join(MAIL_DIR, "agents.json");
const LOG_PATH = join(HOME, ".omp", "mail-daemon.log");
const PID_PATH = join(HOME, ".omp", "mail-daemon.pid");

mkdirSync(MAIL_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { appendFileSync(LOG_PATH, line + "\n"); } catch {}
  console.log(line);
}

let registry = {};
try { registry = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {}; } catch { registry = {}; }
const saveRegistry = () => { try { writeFileSync(REGISTRY, JSON.stringify(registry, null, 2)); } catch {} };

const clients = new Map(); // sessionId -> socket

// --- naming ---------------------------------------------------------------
const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);

function uniqueSlug(want, forId) {
  const base = slugify(want) || "session";
  let slug = base;
  let n = 2;
  const taken = Object.entries(registry)
    .filter(([id]) => id !== forId)
    .map(([, a]) => a.slug)
    .filter(Boolean);
  while (taken.includes(slug)) slug = `${base}-${n++}`;
  return slug;
}

function resolveTarget(to) {
  if (to === "all") return Object.keys(registry);
  if (registry[to]) return [to];
  for (const [id, a] of Object.entries(registry)) {
    if (a.slug === to || (a.aliases ?? []).includes(to)) return [id];
  }
  if (to.length >= 6) {
    const ids = Object.keys(registry).filter((id) => id.startsWith(to));
    if (ids.length === 1) return ids;
  }
  return null;
}

// --- mailboxes ------------------------------------------------------------
const mailboxPath = (id) => join(MAIL_DIR, `${id}.jsonl`);
const readMailbox = (id) => {
  if (!existsSync(mailboxPath(id))) return [];
  return readFileSync(mailboxPath(id), "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
};
const lastSeq = (id) => { const m = readMailbox(id); return m.length ? m[m.length - 1].seq : 0; };
const appendMail = (id, msg) => appendFileSync(mailboxPath(id), JSON.stringify(msg) + "\n");
const sendTo = (socket, obj) => { try { if (socket && !socket.destroyed) socket.write(JSON.stringify(obj) + "\n"); } catch {} };

// --- server ---------------------------------------------------------------
const server = createServer((socket) => {
  let sessionId = null;
  let buffer = "";
  socket.setEncoding("utf8");

  function handle(frame) {
    switch (frame?.type) {
      case "register": {
        const id = frame.sessionId;
        if (sessionId && sessionId !== id) {
          // session switched on this socket: retire the old registration
          clients.delete(sessionId);
          if (registry[sessionId]) { registry[sessionId].alive = false; }
        }
        sessionId = id;
        const prev = clients.get(id);
        if (prev && prev !== socket) { try { prev.destroy(); } catch {} }
        clients.set(id, socket);
        const existing = registry[id] ?? {};
        registry[id] = {
          name: frame.name ?? existing.name ?? id,
          slug: existing.slug || uniqueSlug(frame.name || existing.name, id),
          aliases: existing.aliases ?? [],
          cwd: frame.cwd ?? existing.cwd ?? "",
          pid: frame.pid ?? existing.pid ?? 0,
          lastSeen: Date.now(),
          alive: true,
          cursor: existing.cursor ?? 0,
        };
        saveRegistry();
        log(`register ${id} slug=${registry[id].slug} name=${registry[id].name} pid=${registry[id].pid}`);
        // Replay undelivered mail
        const msgs = readMailbox(id).filter((m) => m.seq > registry[id].cursor);
        for (const m of msgs) sendTo(socket, { type: "mail", ...m });
        const max = msgs.reduce((a, m) => Math.max(a, m.seq), 0);
        registry[id].cursor = max;
        saveRegistry();
        sendTo(socket, { type: "ok", op: "register", sessionId: id, slug: registry[id].slug, reqId: frame.reqId });
        break;
      }
      case "meta": {
        if (!sessionId) return sendTo(socket, { type: "error", op: "meta", message: "not registered", reqId: frame.reqId });
        const a = registry[sessionId];
        if (!a) return sendTo(socket, { type: "error", op: "meta", message: "unknown session", reqId: frame.reqId });
        if (frame.name && frame.name !== a.name) {
          a.name = frame.name; // display name tracks the session title
          // slug is a stable address — never re-rolled on title changes
          saveRegistry();
          log(`meta ${sessionId} name=${a.name} slug=${a.slug}`);
        }
        sendTo(socket, { type: "ok", op: "meta", sessionId, slug: a.slug, reqId: frame.reqId });
        break;
      }
      case "alias": {
        if (!sessionId) return sendTo(socket, { type: "error", op: "alias", message: "not registered", reqId: frame.reqId });
        const a = registry[sessionId];
        if (!a) return sendTo(socket, { type: "error", op: "alias", message: "unknown session", reqId: frame.reqId });
        const want = slugify(frame.name);
        if (frame.set && !want) return sendTo(socket, { type: "error", op: "alias", message: "alias must be slug-like", reqId: frame.reqId });
        if (frame.set) {
          // no cross-session alias theft
          for (const [id, other] of Object.entries(registry)) {
            if (id !== sessionId && ((other.aliases ?? []).includes(want) || other.slug === want)) {
              return sendTo(socket, { type: "error", op: "alias", message: `alias taken by ${id}`, reqId: frame.reqId });
            }
          }
          a.aliases = [want, ...(a.aliases ?? []).filter((x) => x !== want)].slice(0, 5);
        } else {
          a.aliases = (a.aliases ?? []).filter((x) => x !== want);
        }
        saveRegistry();
        log(`alias ${sessionId} ${frame.set ? "+" : "-"}${want}`);
        sendTo(socket, { type: "ok", op: "alias", sessionId, aliases: a.aliases, reqId: frame.reqId });
        break;
      }
      case "send": {
        if (!sessionId) return sendTo(socket, { type: "error", op: "send", message: "not registered", reqId: frame.reqId });
        const targets = resolveTarget(frame.to);
        if (!targets || !targets.length) {
          return sendTo(socket, { type: "error", op: "send", message: `unknown recipient: ${frame.to}`, reqId: frame.reqId });
        }
        if (targets.length === 1 && targets[0] === sessionId) {
          return sendTo(socket, {
            type: "error", op: "send",
            message: `self-send blocked: "${frame.to}" resolves to your own session`,
            reqId: frame.reqId,
          });
        }
        const base = {
          id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
          from: sessionId,
          fromName: registry[sessionId]?.name ?? sessionId,
          fromSlug: registry[sessionId]?.slug,
          subject: frame.subject ?? "",
          body: frame.body ?? "",
          ts: Date.now(),
        };
        let live = 0;
        for (const t of targets) {
          const msg = { ...base, to: t, seq: lastSeq(t) + 1 };
          appendMail(t, msg);
          const sock = clients.get(t);
          if (sock) { sendTo(sock, { type: "mail", ...msg }); live++; }
          else log(`mail ${msg.id} -> ${t} (offline, stored seq=${msg.seq})`);
        }
        log(`send "${base.subject || "(no subject)"}" ${base.from} -> ${frame.to} (${targets.length} mailbox(es), ${live} live)`);
        sendTo(socket, { type: "ok", op: "send", to: frame.to, toId: targets.length === 1 ? targets[0] : null, delivered: targets.length, live, reqId: frame.reqId });
        break;
      }
      case "list": {
        if (!sessionId) return sendTo(socket, { type: "error", op: "list", message: "not registered", reqId: frame.reqId });
        const agents = Object.entries(registry)
          .map(([id, a]) => ({ sessionId: id, ...a }))
          .sort((a, b) => b.lastSeen - a.lastSeen);
        sendTo(socket, { type: "agents", agents, reqId: frame.reqId });
        break;
      }
      case "inbox": {
        if (!sessionId) return sendTo(socket, { type: "error", op: "inbox", message: "not registered", reqId: frame.reqId });
        sendTo(socket, { type: "inbox", messages: readMailbox(sessionId).slice(-50), reqId: frame.reqId });
        break;
      }
      default:
        sendTo(socket, { type: "error", message: `unknown frame type: ${frame?.type}`, reqId: frame?.reqId });
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch (e) { log(`bad frame: ${e.message}`); }
    }
  });

  socket.on("close", () => {
    if (sessionId && clients.get(sessionId) === socket) {
      clients.delete(sessionId);
      if (registry[sessionId]) {
        registry[sessionId].alive = false;
        registry[sessionId].lastSeen = Date.now();
        saveRegistry();
      }
      log(`disconnect ${sessionId}`);
    }
  });

  socket.on("error", () => {});
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const probe = netConnect(SOCK);
    probe.on("connect", () => { probe.destroy(); console.log("another daemon is live; exiting"); process.exit(0); });
    probe.on("error", () => {
      probe.destroy();
      try { unlinkSync(SOCK); } catch {}
      server.listen(SOCK, onListen);
    });
  } else {
    console.error(err);
    process.exit(1);
  }
});

function onListen() {
  writeFileSync(PID_PATH, String(process.pid));
  log(`omp-mail daemon listening on ${SOCK} (pid ${process.pid})`);
}
server.listen(SOCK, onListen);
