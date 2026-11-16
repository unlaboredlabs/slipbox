# slipbox: design (v2)

A shared memory for agents. Every agent connects over MCP, and everything they know lives as plain Markdown files on disk. Not for human edits, not a notebook.

## Principles

1. Files are the truth: a folder of `.md` files, readable with `cat` and `grep`.
2. Git is the history: every write is a commit authored by the agent, with its one-line `why` as the message.
3. The database is only a helper: search index, embeddings, agent keys, activity log. Delete it and everything rebuilds from the files.
4. The server has no LLM in it. A small local embedding model is the only model, and search works without it.
5. One Bun process, one port: `/mcp` (agents), `/api` (dashboard data), `/` (dashboard static files).

## Files

```
data/
  shared/              what every agent should know
  projects/<name>/     one folder per project
  agents/<name>/       an agent's own notes
```

- Plain Markdown, no frontmatter. Title = first `# heading`; summary = first paragraph under it.
- Size cap per file, 32 KB by default (`MAX_FILE_BYTES`). A write past it is refused with a message telling the agent to split or condense.
- Paths: lowercase `[a-z0-9._-]` segments, must end in `.md`, no `..`, no absolute paths, no symlink escape from `DATA_DIR`.
- Access by path prefix: a key has read or write grants on prefixes such as `shared/` or `projects/shop/`.
- `profile.md` in any folder is that folder's profile: the short, always-current facts (who, what, conventions). `start` returns the profiles on the way down to a path. Cap 4 KB each.
- Files changed outside the server (git pull, manual fix) are picked up: full reconcile on start (by content hash), and a watcher on the folder afterwards.
- `data/` is its own git repo, created on first start.

## MCP tools

| Tool | What it does |
|---|---|
| `start(path?)` | What to load first: every `profile.md` from the root down to `path` that the key may read, plus the map of `path` (as `list`). |
| `list(path)` | Folders and files under a path, each with its one-line summary, size and last change. |
| `search(query, path?, limit?)` | Hybrid search. Returns matching sections: file, heading, line range, snippet, score, and which of words/meaning matched. |
| `read(path, lines?)` | A file or a line range, with its version (content hash). |
| `write(path, content, why, baseVersion?)` | Create or replace. Replacing an existing file needs `baseVersion`; if it is stale, the write is refused and the current version and text come back. |
| `edit(path, old, new, why)` | Exact text replacement (`old` must match exactly once), or append when `old` is empty. |
| `delete(path, why)` | Remove a file. It stays in git history. |
| `history(path, limit?)` | The file's versions: when, which agent, why. `read` accepts a `version` from here to read an old one. |

- Transport: MCP Streamable HTTP at `/mcp`, `Authorization: Bearer <key>`. Keys are stored hashed.
- Writes to the same file are serialised in-process (one lock per path, one for git commits).
- The server's MCP `instructions` tell agents the convention: call `start` first, search before writing, update an existing note rather than add a duplicate, keep the first paragraph a true summary, keep `profile.md` short and current, and correct a wrong fact in place (history keeps the old one).

## Search: words + meaning, and how it stays reliable

- Each file is split into sections at headings (long sections split further at paragraph boundaries, about 1500 characters).
- Word index: SQLite FTS5 / Postgres `tsvector`, BM25 (Postgres has none built in, so it ranks with `ts_rank`, its nearest equivalent), title and heading weighted higher. Common English stop words are dropped from queries on both.
- Meaning index: one embedding per section from a local model that runs in-process (default `Xenova/bge-small-en-v1.5` via `@huggingface/transformers`, 384 dims; `EMBED_MODEL` changes it). No external API, so no outage, key or network between an agent and its memory.
- The two result lists are merged with reciprocal rank fusion.

Reliability rules, each with a test:

1. **Words never depend on vectors.** If the model fails to load or an embedding fails, search still answers from the word index and says `meaning: unavailable` in the result.
2. **Exact, not approximate.** Vector search is brute-force cosine over all permitted sections, held in memory as Float32 arrays. No ANN index, so no missed neighbours and nothing to tune. Fine to about 100k sections; a note in the code says where to add an index if that is ever passed.
3. **Never stale.** An embedding is keyed by the hash of its section text plus the model name. A changed section gets a new one; a deleted section's is dropped; changing the model re-embeds everything. Search only uses embeddings whose hash matches the current section.
4. **Writes never wait on the model.** A write commits the file and updates the word index synchronously, then queues the embedding. Until it lands, that section is found by words. The queue survives a restart because pending work is derived (sections without a matching embedding), not stored.
5. **Visible.** `/api/health` and the dashboard show: model loaded or not, sections embedded / total, queue length, last error.
6. **Rebuildable.** `bun run reindex` drops and rebuilds both indexes from the files.

## Dashboard (read-only, for watching)

TanStack Router + Query + Table, shadcn/ui, Vite; built to static files served by the Bun process. Neutral accent (black in light mode), dark mode, no explanatory text under rows.

| Page | Shows |
|---|---|
| Files | The tree, a rendered file, its history and diffs. One action: restore an older version. |
| Activity | Who read, searched and wrote what, live. |
| Agents | Create a key (shown once), set its path prefixes, last seen, revoke. |
| Search | Run a query and see exactly what an agent would get, with word/meaning scores, plus index health. |

One admin login: `ADMIN_TOKEN` from the environment, sent as a bearer token.

## HTTP API for the dashboard (`/api`, bearer `ADMIN_TOKEN`, JSON)

```
GET    /api/health                      { ok, db, version, embed: { model, loaded, embedded, total, queued, lastError } }
GET    /api/tree?path=                  { path, entries: [{ name, path, type: "dir"|"file", summary, bytes, updatedAt }] }
GET    /api/file?path=&version=         { path, title, summary, content, version, bytes, updatedAt }
GET    /api/history?path=&limit=        { versions: [{ version, commit, at, agent, why }] }
GET    /api/diff?path=&from=&to=        { diff }            unified diff text between two commits; without from, the file as created
POST   /api/restore   { path, commit }  { version }         writes the old content as a new commit by "admin"
GET    /api/search?q=&path=&limit=      { meaning: "ok"|"unavailable", results: [{ path, heading, startLine, endLine, snippet, score, wordRank, meaningRank }] }
GET    /api/events?after=&limit=&agent= { events: [{ id, at, agent, action, path, query, ok }] }   newest first, only ids > after
GET    /api/events/stream               server-sent events, one JSON event per message (also takes ?token=, as EventSource cannot send headers)
GET    /api/agents                      { agents: [{ id, name, createdAt, lastSeenAt, revoked, grants: [{ prefix, mode: "read"|"write" }] }] }
POST   /api/agents    { name, grants }  { agent, key }      key shown once
PATCH  /api/agents/:id { grants?, revoked? }  { agent }
```

Errors: `{ error: { code, message } }` with a fitting status. `db` is `"sqlite"` or `"postgres"`; `version` is the release number, or `"dev"`.

## Storage

Plain SQL, no ORM, via Bun's built-in SQL client. SQLite is the default (`data.db` next to the data folder); Postgres when `DATABASE_URL` starts with `postgres`.

- `agents` (id, name, key_hash, created_at, last_seen_at, revoked), `grants` (agent_id, prefix, mode)
- `docs` (path, title, summary, hash, bytes, updated_at)
- `sections` (id, doc_path, heading, start_line, end_line, text, text_hash) + full-text index
- `embeddings` (text_hash, model, dims, vector blob)
- `events` (id, at, agent, action, path, query, ok)

Both backends sit behind one small interface; only the full-text query differs. Embeddings are plain blobs in both (no pgvector needed).

## Layout

```
server/   Bun + TypeScript
  cli.ts      the command line
  index.ts    serve /mcp, /api, static
  memory.ts   the operations the tools and the API share
  mcp.ts      the tools
  api.ts      dashboard API
  files.ts    read/write, size cap, path rules, locks
  git.ts      commit, history, diff, restore
  index/      sections.ts, words.ts, embed.ts, search.ts
  db/         store.ts (the interface), sqlite.ts, postgres.ts (each with its schema)
  service.ts  systemd / launchd
  build.ts    the single compiled program
  test/
web/      Vite, TanStack, shadcn
data/     the Markdown files (its own git repo, git-ignored by this one)
```

Config: `DATA_DIR`, `DATABASE_URL`, `ADMIN_TOKEN`, `HOST` (default `127.0.0.1`), `PORT` (default 7323), `MAX_FILE_BYTES`, `EMBED_MODEL` (`off` disables meaning search), `CONFIG_FILE` (where the config file is), `SERVICE_NAME` (the service's name, to run a second instance).

## Install and CLI

Open source (MIT). Setting it up is one line, then a service:

```
curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/slipbox/main/install.sh | sh   # puts one `slipbox` command in ~/.local/bin
slipbox service install       # registers it to run in the background and at login, and starts it
slipbox service start | stop | status | logs
slipbox service uninstall     # removes the service; data and config stay
```

- The command is one self-contained program with the dashboard built in (`bun build --compile`, dashboard files embedded). If the embedding model's native runtime cannot be bundled dependably, the fallback is an installer that fetches Bun and the package; either way the person types one line.
- `service` uses what the OS has: a systemd user unit on Linux, a launchd agent on macOS. No root, no Docker.
- Other commands: `serve` (run in the foreground), `key create <name> --read <prefix> --write <prefix>` / `key list` / `key revoke <name>`, `reindex`, `status` (URL, data folder, index health), `update` (the same download as the installer, then restarts the service if installed), `version`.
- First run needs no configuration: it creates the data folder (`~/.local/share/slipbox`, with the notes in `data/`, `data.db` and the model beside it), a config file (`~/.config/slipbox/config.env`) with a generated admin token, and prints the dashboard URL and the line to connect an agent. Environment variables override the config file.
- The embedding model downloads once on first start into the data folder; until it has, search answers by words.
- The install script detects OS and CPU, downloads the matching release from GitHub, checks its checksum, and never needs sudo.
- Releases: one rolling prerelease tagged `edge`, rebuilt on every push to main that passes CI, for Linux and macOS on x64 and arm64 (`slipbox-<os>-<arch>`, plus `checksums.txt` and a `version` file). The version is one integer, the number of commits on main; `slipbox version` prints `slipbox 42 (abc1234, 2026-11-16)`, a local build prints `slipbox dev`.

## Left out on purpose

- Any LLM inside the server (no fact extraction, no auto-summaries, no background rewriting)
- An editor, comments or anything else for people to write with
- Approximate vector indexes, external embedding APIs, rerankers
- Real-time co-editing, plugins, webhooks, user accounts, teams, per-file permissions
