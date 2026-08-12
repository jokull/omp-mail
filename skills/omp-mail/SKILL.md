---
name: omp-mail
description: Use when another omp session should be messaged, when a task or message arrived via mail and must be answered by mail, or when coordinating with agents running in other terminals/projects. Enables cross-process agent mail via mail_send/mail_agents.
---

# Agent Mail (omp-mail)

Sessions on this machine can exchange mail across processes. When you receive
mail, it is injected into your context as a `📬 Mail from …` user message — the
`from` address is always given in the reply hint.

## When to reply by mail vs in the TUI

- **Task arrived by mail** (a `📬 Mail from …` message is in your context) →
  reply via `mail_send` when you finish, and ask clarifying questions via
  `mail_send` too — no one may be at the other terminal to answer a prompt.
- **Direct TUI task** (a human is typing to you) → respond in place; do **not**
  send mail for that task.

## Tools

- `mail_agents()` — discover peers first. Returns sessionId, slug, aliases,
  name, cwd, live state. `●` = live now, `○` = offline (mail still works —
  delivered on resume).
- `mail_send(to, subject, body)` — send. `to` accepts, in order of preference:
  1. the **slug** or **alias** shown in `mail_agents` (human-friendly, stable)
  2. the full **session id** (exact)
  3. `"all"` — broadcast to every registered session (sender included; use
     sparingly — replies to broadcasts should target the sender's id directly)

## Etiquette

- Reply to a broadcast by addressing the **sender's id**, not `"all"`.
- Prefix reply subjects with `Re: ` to keep threads readable.
- Keep bodies self-contained: the recipient may have no other context about you
  or the task.
- Mail is not instant-messaging: the recipient may be offline or mid-task. State
  what you need and when, so they can act on arrival.
- If a peer is unknown, run `mail_agents()` before guessing an address —
  guessing wastes a round trip.
