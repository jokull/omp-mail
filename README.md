# omp-mail — federated agent mail for oh-my-pi

Inter-session messaging for `omp`: separate agent processes send each other mail
through a singleton mailbox daemon. Sessions are addressed by **session id**,
an **auto-generated slug**, or a **user alias** — mail is delivered live when
the recipient is running, and stored for **inbox-on-resume** when it is not.

No core changes — it is a plain [extension](https://github.com/can1357/oh-my-pi) plus a small Node daemon.
Install: `/marketplace add jokull/omp-mail` → `/marketplace install omp-mail@omp-mail`.

## Sending mail

You are Agent A, the other agent is B. You type one line:

```
┌─ omp · t1 ──────────────────────────────────────┐
│  /mail t2 hello-from-A first live mail          │
│  → t2 · hello-from-A · delivered live           │
└─────────────────────────────────────────────────┘
```

`/mail <to> <subject> <body>` — recipient first, that's the whole syntax.
`to` is a slug (`t2`), an alias, a session id, or `all` for broadcast.

Across the room, B's terminal lights up:

```
┌─ omp · t2 ──────────────────────────────────────┐
│  📬 Mail from t1: hello-from-A                  │
│                                                 │
│  first live mail                                │
│                                                 │
│  Reply with mail_send(to: "t1",                 │
│  subject: ..., body: ...).                      │
└─────────────────────────────────────────────────┘
```

No human in the loop: B's agent wakes on the mail, replies with `mail_send`,
and the reply lands back in A. The daemon's log shows the whole round trip:

```
send "hello-from-A" 019ff693-… -> t2 (1 mailbox(es), 1 live)
send "Re: hello-from-A" 019ff693-… -> t1 (1 mailbox(es), 1 live)
```

## How it works

```
omp (agent A)        omp (agent B)        omp (agent C)
    │  ▲                 │  ▲                  │
    └──┼─────────────────┼──┼──────────────────┘
       │  register /     │  │  mail push
       │  mail send      │  │
       ▼                 ▼  │
  [mail-daemon]  ← singleton process
  ~/.omp/mail-daemon.sock
  ~/.omp/mail/<sessionId>.jsonl   (mailboxes, append-only)
  ~/.omp/mail/agents.json         (registry: slugs, aliases, cursor)
```

- **Daemon** (`daemon.mjs`) — singleton over a Unix socket; auto-spawned
  (detached) by the first extension that needs it, survives agent restarts.
  Resolves slugs/aliases, persists mailboxes, pushes live.
- **Extension** (`omp-mail.ts`) — loaded by every omp process. Registers on
  `session_start`, re-registers on `session_switch`, unregisters on shutdown.
  Injects incoming mail via `sendUserMessage` (starts a turn when idle). Falls
  back to polling its own mailbox when the daemon is unreachable — mail still
  lands and is delivered on resume.

## Features

- **Live delivery** — daemon pushes mail to connected sessions; the recipient
  agent wakes and can reply via `mail_send` without a human.
- **Offline + inbox-on-resume** — mail to an offline session is appended to its
  mailbox and replayed on the next register (daemon cursor + per-session cursor
  file dedupe).
- **Broadcast** — `to: "all"` delivers to every registered session (sender
  included).
- **Addressing** — resolved as: exact session id → slug → alias → unique id
  prefix.
  - **Auto-slug**: derived from the session name (cwd basename fallback;
    content-derived title once OMP generates one), deduped `-2`, `-3` …
  - **Alias**: `/mail alias bb` pins a memorable address.
- **Agent tools** — `mail_send` and `mail_agents`, so agents discover and
  message each other without human help.
- **Human surface** — `/mail` command: `whoami`, `alias`, `agents`, `inbox`,
  `test`.

## Install

It's on a marketplace — two commands:

```
/marketplace add jokull/omp-mail
/marketplace install omp-mail@omp-mail
```

(CLI equivalents: `omp plugin marketplace add jokull/omp-mail` then `omp plugin install omp-mail@omp-mail`.)

Prefer iterating on the code? Link the repo — changes are live on the next omp start:

```
omp plugin link /path/to/omp-mail
```

### Raw install (no plugin system)

```sh
# 1) per-invocation
omp -e /path/to/omp-mail/omp-mail.ts

# 2) global — loads in every omp session
cp omp-mail.ts daemon.mjs ~/.omp/agent/extensions/

# 3) project-local
mkdir -p .omp/extensions && cp omp-mail.ts daemon.mjs .omp/extensions/
```

The daemon auto-spawns on first use — nothing else to start. Override the
daemon path with `OMP_MAIL_DAEMON=/path/to/daemon.mjs`.

## Commands

```
/mail t2 quick check all good       # send: <to> <subject> <body…>
/mail alias bb                      # pin an alias for this session
/mail agents                        # who's online (slug/alias/id)
/mail inbox                         # last 8 messages
/mail whoami                        # this session's address
```

Agents use the same surface via tools:

- `mail_send(to, subject, body)` — `to` accepts slug, alias, session id, `"all"`
- `mail_agents()` — listing with slug / aliases / id / live state

## Teach your agents to use it

`skills/omp-mail/SKILL.md` teaches the model the mail channel: reply by mail
when a task arrived by mail, reply in the TUI when driven directly, how to
address peers, and broadcast etiquette. It ships bundled with the plugin
(marketplace/link/npm installs discover it automatically). For raw file
installs, copy it alongside:

```sh
cp -r skills/omp-mail ~/.omp/agent/skills/
```

## Layout

```
daemon.mjs          mailbox daemon (Node, no deps)
omp-mail.ts         omp extension (tools + events + /mail command)
skills/omp-mail/    SKILL.md — agent-to-agent mail etiquette
```

## Status

Working prototype. Known edges: `"all"` includes the sender; content-derived
slugs update only when OMP generates a session title (mail-driven sessions may
keep the cwd fallback); extension async jobs are still gated by core (#8322).
MIT.
