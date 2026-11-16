# slipbox

[![CI](https://github.com/unlaboredlabs/slipbox/actions/workflows/ci.yml/badge.svg)](https://github.com/unlaboredlabs/slipbox/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A shared memory for your agents. Every agent connects over MCP, and what they know is kept as plain Markdown files in a folder, with every change committed to git: who wrote it, when, and why. You can read it all with `cat` and `grep`.

Search finds notes by their words and by their meaning, using a small embedding model that runs inside the program. There is no LLM in it, nothing leaves your machine, and a read-only dashboard lets you watch what agents read and write.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/slipbox/main/install.sh | sh
slipbox service install
```

The first line puts one `slipbox` program in `~/.local/bin` (Linux and macOS, x64 and arm64; no sudo). The second runs it in the background and at login, with a systemd user unit on Linux or a launchd agent on macOS. The dashboard is then at <http://127.0.0.1:7323>; sign in with the `ADMIN_TOKEN` from `~/.config/slipbox/config.env`, which the first run creates.

```sh
slipbox service start | stop | status | logs
slipbox service uninstall    # removes the service; your notes and config stay
slipbox update               # installs the latest build and restarts the service
slipbox status               # where it runs, where the data is, search health
```

To run it in the foreground instead: `slipbox serve`.

## Connect an agent

Create a key for each agent, with the folders it may read or write (`/` means everything):

```sh
slipbox key create claude --write /
slipbox key create reviewer --read shared --read projects/shop --write agents/reviewer
slipbox key list
slipbox key revoke reviewer
```

The key is shown once. For Claude Code:

```sh
claude mcp add --transport http slipbox http://127.0.0.1:7323/mcp --header "Authorization: Bearer <key>"
```

For other MCP clients that speak Streamable HTTP:

```json
{
  "mcpServers": {
    "slipbox": {
      "type": "http",
      "url": "http://127.0.0.1:7323/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Agents get eight tools: `start`, `list`, `search`, `read`, `write`, `edit`, `delete` and `history`, and instructions to call `start` first, search before writing, and correct facts in place rather than add duplicates.

## How notes are kept

```
~/.local/share/slipbox/
  data/                  the notes: a git repository
    shared/              what every agent should know
    projects/<name>/     one folder per project
    agents/<name>/       an agent's own notes
  data.db                the search index, keys and activity log
  models/                the embedding model, downloaded on first start
```

- A note's title is its first `# heading`, and its summary is the first paragraph under it.
- `profile.md` in any folder holds the short, always-current facts for that folder. `start` returns every profile from the root down to where the agent works.
- Notes are capped at 32 KB (profiles at 4 KB), so agents split big topics instead of growing one file forever.
- Replacing a note needs the version the agent read; if someone changed it since, the write is refused and the current text comes back to merge.
- Changes made outside slipbox (a `git pull`, a manual fix) are picked up on start and while it runs.

The database only helps: delete it, and everything is rebuilt from the files on the next start (or with `slipbox reindex`).

## How search works

Each note is split into sections at its headings. A search runs two ways at once:

- **Words**: a full-text index (SQLite FTS5, or Postgres `tsvector`) that ranks sections by how well they match, with titles and headings counting more.
- **Meaning**: each section has an embedding from a local model (`Xenova/bge-small-en-v1.5` by default). The query is compared with every section the key may read, and a section counts as a match only if it is close enough: above a fixed similarity floor, and near the best match. A query that nothing answers gets no meaning matches rather than the least bad ones.

The two ranked lists are merged with reciprocal rank fusion, and each result says whether words, meaning or both matched.

What it guarantees:

1. **Words never depend on the model.** If the model is missing, still downloading or fails, search answers from the word index and says `meaning: unavailable`.
2. **Exact, not approximate.** Meaning search compares the query with every permitted section, so no close match is missed.
3. **Never stale.** An embedding is tied to the exact text of its section and the model's name. An edited section is found by words until its new embedding is ready; an old one is never used.
4. **Writes never wait on the model.** A write is committed and searchable by words at once; its embedding follows in the background, and pending work resumes after a restart.
5. **Visible.** `slipbox status`, `/api/health` and the dashboard show whether the model is loaded, how many sections are embedded, the queue, and the last error.
6. **Rebuildable.** `slipbox reindex` rebuilds both indexes from the files.

The macOS build for Intel Macs has no embedding runtime, because onnxruntime no longer ships one for that platform; there, search uses words only.

## Configuration

Set these in `~/.config/slipbox/config.env` or as environment variables (which win).

| Variable | Default | |
|---|---|---|
| `ADMIN_TOKEN` | generated on first run | The dashboard's login, sent as a bearer token |
| `DATA_DIR` | `~/.local/share/slipbox/data` | The notes folder; the database and model sit next to it |
| `DATABASE_URL` | `data.db` next to `DATA_DIR` | A `postgres://` URL to use Postgres instead of SQLite |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to let agents on other machines connect |
| `PORT` | `7323` | |
| `MAX_FILE_BYTES` | `32768` | Size cap per note |
| `EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Any feature-extraction model on Hugging Face with ONNX weights; `off` for words only |
| `CONFIG_FILE` | `~/.config/slipbox/config.env` | |
| `SERVICE_NAME` | `slipbox` | To run a second instance as its own service |

Changing `EMBED_MODEL` re-embeds every section on the next start. The meaning floor (`MEANING_FLOOR` in `server/index/embed.ts`) is measured for the default model; another model may need it measured again.

## Development

You need [Bun](https://bun.sh) 1.4 and git.

```sh
bun install
bun run serve                 # the server from source
bun test                      # the tests on SQLite
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test   # and on Postgres
bun run typecheck
bun run build                 # dist/slipbox, with web/ built and embedded when present
```

Each Postgres test run creates and drops its own databases, so the URL only needs a user that may create them. The tests that use the real model download it once into your temp folder.

The server is in `server/`, the dashboard in `web/`, and [DESIGN.md](DESIGN.md) describes both.

## License

MIT
