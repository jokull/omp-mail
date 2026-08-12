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
  Reply only when a response is actually wanted: new work, a question, or a
  blocker. Pure confirmations and closings need no reply.
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

## Invocation: JSON args

`mail_send` takes its arguments as a JSON object — `{ "to": …, "subject": …, "body": … }`.
Write it as **valid single-line JSON**: literal newlines inside a JSON string are a
parse error ("Unterminated string"). For long or multiline bodies:

- **Point, don't paste.** The recipient is an agent with full tool access — it can
  read repo files itself. A body like `See HANDOFF.md in the repo root — implement
  the fix there, reply by mail when done or blocked.` beats pasting a document into
  JSON.
- Only inline text the recipient cannot read itself.
- If you must inline multiline text, escape newlines (`\n`) in the JSON string.

## Etiquette

- **Don't acknowledge acknowledgments.** If the last message was a
  confirmation, a closing, or a status update with no question and no blocker,
  do **not** reply — the thread is over. Replying to closings starts an
  "ok bye" loop. The mail layer suppresses turn-triggering for rapid
  back-and-forth with the same peer; treat that as a signal the thread is done.
- Reply to a broadcast by addressing the **sender's id**, not `"all"`.
- Prefix reply subjects with `Re: ` to keep threads readable.
- Keep bodies self-contained in context: say who you are and what you need — the
  recipient may have no other context about you or the task. For detail, point to
  files the recipient can read; don't paste large documents into the body.
- Mail is not instant-messaging: the recipient may be offline or mid-task. State
  what you need and when, so they can act on arrival.
- If a peer is unknown, run `mail_agents()` before guessing an address —
  guessing wastes a round trip.
