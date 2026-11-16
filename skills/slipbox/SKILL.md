---
name: slipbox
description: How to use slipbox, the shared Markdown memory agents reach over MCP, at the right moments. Use it at the start of any work when a slipbox MCP server is connected, before making a decision or asking the person something, when you learn something worth keeping, and when you stop mid-work or hand over to another agent.
---

# Using slipbox well

slipbox is the memory you share with the other agents and with your own past sessions. The tools explain how they work. This skill covers when to use them and what is worth keeping.

## At the start of work

1. Call `start` with the folder of the project you are working on, such as `start("projects/shop")`. Use the root only when the work has no project.
2. Read the profiles it returns and follow them. They are the project's current facts and rules.
3. Note the name `start` gives you. Your own notes go in `agents/<that name>/`.
4. Before planning, search for the task's topic: `search("<topic in plain words>", path: "projects/<name>")`, then once more without `path` if nothing relevant comes back. Read the sections that match.
5. If you are resuming your own work, or picking up someone else's, look for a handover note first (see the end of this skill).

## Before you decide or ask

Before choosing an approach, or asking the person a question, search for it. Someone may already have decided it, written down why, or been told the answer. If a note answers it, follow the note and say so. If you disagree with it, raise that rather than quietly doing something else.

Ask the person only what the memory does not answer, and write the answer down afterwards.

## What to write down

Write a note when you learn something the next agent would otherwise have to work out or ask again:

- A decision and its reason, including what was rejected.
- A convention: how this project names, tests, deploys or reviews things.
- A how-to that took real effort to get right: the working command, the trap and how to avoid it.
- A fact about a person or a system: who owns what, how they like to work, which port or version is in use.
- A correction: something written down that turned out to be wrong.

Do not write:

- Secrets: keys, passwords, tokens, personal data. Say where a secret lives, never its value.
- Raw logs, stack traces or command output. Write what they showed in one line.
- What the repo or git already says: the code, the README, commit messages, the diff.
- A diary of the steps you took. Keep the result and the reason, not the path to it.

Write at the moment you learn it, not only at the end; a session can stop at any time.

## Where it goes

- `shared/`: what every agent should know whatever the project: the people, house conventions, shared infrastructure.
- `projects/<name>/`: one project's decisions, conventions, systems and how-tos. Use the project's existing folder name; `list projects` shows them.
- `agents/<your name>/`: your own working notes, handovers and scratch thinking that is not yet a fact for others.

One topic per note. Name the file after the topic, such as `projects/shop/decisions/valkey-for-sessions.md` or `shared/people/priya.md`, not `notes.md` or `2026-11-16.md`. Follow any layout the folder's `profile.md` or existing notes already use. The first paragraph says what the note holds and the current answer, so a reader of `list` or a search snippet knows if it is the one they need.

## Update in place

- Search before every new note. If a note on the topic exists, `edit` it, even when your fact is only a small addition.
- When a note is wrong, fix the sentence where it stands, with a `why` that says what was wrong. Do not add a second note that contradicts it.
- When you find two notes on one topic, merge them into the better one and delete the other.
- `profile.md` is loaded at every `start`. Keep it to the few facts every agent in that folder needs, and move detail into its own note with a one-line pointer. When something in a profile stops being true, change it in that session.

## Stopping mid-work or handing over

Before you stop with work unfinished, write or update one handover note in your own folder, named after the work: `agents/<your name>/handover-<topic>.md`.

```markdown
# Handover: move shop sessions to Valkey

Half done: staging runs on Valkey, production still on Redis. Next is the production cut-over.

## Done
- Staging switched; decision in projects/shop/decisions/valkey-for-sessions.md.
## Next
- Cut production over on a weekday morning; Priya wants to be told first.
## Open questions
- Keep Redis running a week as a fallback?
```

Put facts that outlive the work (decisions, conventions, how-tos) in the project's notes, not only in the handover. If another agent will take over, tell them or the person the handover's path. To pick one up: `list agents/<name>/`, or `search("handover <topic>")`. When the work is finished, delete the handover with a `why` saying where the result is.

## Examples

A good note:

```markdown
# Shop sessions are stored in Valkey

Shop sessions moved from Redis to Valkey on 2026-11-16 because of the Redis license change. Same protocol and client; only the connection URL changed.

- Production URL is in the shop's deploy config as SESSION_STORE_URL.
- Rejected: Postgres-backed sessions (a write on every request).
```

A good `why`: "Record the Valkey decision and the rejected Postgres option" or "Fix: local Postgres port is 5432, not 5433 (docker-compose.yml)". A bad one: "update" or "notes".
