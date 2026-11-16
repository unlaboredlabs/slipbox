# slipbox

[![CI](https://github.com/unlaboredlabs/slipbox/actions/workflows/ci.yml/badge.svg)](https://github.com/unlaboredlabs/slipbox/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A shared memory for your agents. Every agent connects over MCP, and what they know is kept as plain Markdown files in a folder, with every change committed to git: who wrote it, when, and why. You can read it all with `cat` and `grep`.

Search finds notes by their words and by their meaning, using a small embedding model that runs inside the program. There is no LLM in it and your notes never leave your machine. A read-only dashboard lets you watch what agents read and write.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/slipbox/main/install.sh | sh
slipbox service install
```

The first line puts one `slipbox` program in `~/.local/bin` (Linux and macOS, x64 and arm64; no sudo). It needs git (on macOS, the Command Line Tools). The second runs it in the background and at login, with a systemd user unit on Linux or a launchd agent on macOS. The dashboard is then at <http://127.0.0.1:7323>; sign in with the `ADMIN_TOKEN` from `~/.config/slipbox/config.env`, which the first run creates.

If `slipbox` is not found, `~/.local/bin` is not on your PATH yet (the installer prints the line to add). Meanwhile run it by its full path: `~/.local/bin/slipbox service install`.

```sh
slipbox service start | stop | status | logs
slipbox service uninstall    # removes the service; your notes and config stay
slipbox update               # installs the latest build and restarts the service
slipbox status               # where it runs, where the data is, search health
```

To run it in the foreground instead: `slipbox serve`.

### What it downloads

- `install.sh` and `slipbox update` download the program and `checksums.txt` from this repository's [`edge` release](https://github.com/unlaboredlabs/slipbox/releases/tag/edge) on github.com, and check the checksum.
- The first start downloads the embedding model (about 130 MB) once from huggingface.co into `models/`, and unpacks the embedding runtime (about 45 MB) from the program into the same folder. Until the model is there, search works by words.
- Nothing else. Notes, searches and keys stay on your machine.

### Verify a download

Each release build carries a signed build provenance from GitHub Actions. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify ~/.local/bin/slipbox -R unlaboredlabs/slipbox
```

This checks that the file was built by this repository's release workflow on GitHub Actions, and has not been changed since.

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
  data.db                the search index, agent keys and activity log
  models/                the embedding model and runtime, fetched on first start
```

- A note's title is its first `# heading`, and its summary is the first paragraph under it.
- `profile.md` in any folder holds the short, always-current facts for that folder. `start` tells the agent its name and own folder, and returns the root profile, `shared/profile.md` and every profile down to where the agent works.
- Notes are capped at 32 KB (profiles at 4 KB), so agents split big topics instead of growing one file forever.
- Replacing a note needs the version the agent read; if someone changed it since, the write is refused and the current text comes back to merge.
- Changes made outside slipbox (a `git pull`, a manual fix) are picked up on start and while it runs.

The notes can always be rebuilt into a new index from the files (on the next start, or with `slipbox reindex`). Agent keys and the activity log live only in `data.db`, though: deleting it rebuilds the search index from the files, but every agent key must be created again.

## How search works

Each note is split into sections at its headings. A search runs two ways at once:

- **Words**: a full-text index (SQLite FTS5, or Postgres `tsvector`) that ranks sections by how well they match, with titles and headings counting more.
- **Meaning**: each section has an embedding from a local model (`Xenova/bge-small-en-v1.5` by default), which runs on its own thread so it never holds up the agents. The query is compared with every section the key may read, and a section counts as a match only if it is close enough: above a fixed similarity floor, and near the best match. A query that nothing answers gets no meaning matches rather than the least bad ones.

The two ranked lists are merged with reciprocal rank fusion. Agents get one entry per matching note, with its last change, the line ranges that matched (and whether by words, meaning or both) and a snippet that keeps the note's lines.

What it guarantees:

1. **Words never depend on the model.** If the model is missing, still downloading or fails, search answers from the word index and says meaning search is unavailable.
2. **Exact, not approximate.** Meaning search compares the query with every permitted section, so no close match is missed.
3. **Never stale.** An embedding is tied to the exact text of its section and the model's name. An edited section is found by words until its new embedding is ready; an old one is never used.
4. **Writes never wait on the model.** A write is committed and searchable by words at once; its embedding follows in the background, and pending work resumes after a restart.
5. **Visible.** `slipbox status`, `/api/health` and the dashboard show whether the model is loaded, how many sections are embedded, the queue, and the last error.
6. **Rebuildable.** `slipbox reindex` rebuilds both indexes from the files.

The macOS build for Intel Macs has no embedding runtime, because onnxruntime no longer ships one for that platform; there, search uses words only.

## Configuration

Set these in `~/.config/slipbox/config.env`. To override one for a single run, set it in the environment with a `SLIPBOX_` prefix, such as `SLIPBOX_PORT=7400 slipbox serve`. Plain names in the environment are ignored, so a `DATABASE_URL` meant for another app never reaches slipbox.

| Name | Default | |
|---|---|---|
| `ADMIN_TOKEN` | generated on first run | The dashboard's login, sent as a bearer token |
| `DATA_DIR` | `~/.local/share/slipbox/data` | The notes folder; the database and model sit next to it |
| `DATABASE_URL` | `data.db` next to `DATA_DIR` | A `postgres://` URL to use Postgres instead of SQLite |
| `HOST` | `127.0.0.1` | The address to listen on; see [Other machines](#other-machines) |
| `PORT` | `7323` | |
| `MAX_FILE_BYTES` | `32768` | Size cap per note |
| `EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Any feature-extraction model on Hugging Face with ONNX weights; `off` for words only |
| `SERVICE_NAME` | `slipbox` | The service's name, to run a second instance |

`SLIPBOX_CONFIG_FILE` points to another config file. The service reads only its config file, so a second instance gets its own file with its own `DATA_DIR`, `PORT` and `SERVICE_NAME`, installed with `SLIPBOX_CONFIG_FILE=<that file> slipbox service install`. After changing the file, restart the service with `slipbox service stop` and `slipbox service start`.

Changing `EMBED_MODEL` re-embeds every section on the next start. The meaning floor (`MEANING_FLOOR` in `server/index/embed.ts`) is measured for the default model; another model may need it measured again.

### Postgres

Create an empty database and a user that owns it, then set the URL in the config file:

```sh
createdb slipbox
echo 'DATABASE_URL=postgres://user:password@localhost:5432/slipbox' >> ~/.config/slipbox/config.env
```

slipbox creates its tables on the next start. The notes stay files on disk either way.

### Other machines

slipbox speaks plain HTTP, so agent keys and the admin token cross the network unencrypted. Never expose the port to the open internet. Two safe ways to reach it from other machines:

- A reverse proxy with TLS (Caddy, nginx) on the same machine. slipbox stays on `127.0.0.1`; agents use `https://<name>/mcp`.
- A private network (Tailscale, WireGuard). Set `HOST` to the machine's address on that network; agents use `http://<address>:7323/mcp`.

## Backup and moving machines

Everything lives in two places: `~/.local/share/slipbox` (notes, database, model) and `~/.config/slipbox/config.env` (the admin token). The notes alone are not enough: the agent keys and activity log exist only in `data.db`.

To back up or move, stop the service first, because a SQLite file copied while it is being written can be inconsistent:

```sh
slipbox service stop
tar czf slipbox-backup.tgz -C ~ .local/share/slipbox .config/slipbox
slipbox service start
```

To restore, or to move to another machine: install slipbox there, stop its service, unpack the archive into the home folder (`tar xzf slipbox-backup.tgz -C ~`) and start it again. The `models/` folder can be left out; it downloads again.

For a backup without stopping: `sqlite3 ~/.local/share/slipbox/data.db ".backup backup.db"` copies the database safely, and `data/` is a git repository you can push to a private remote. With Postgres, use `pg_dump`.

## Troubleshooting

- **The service does not start.** `slipbox service logs` shows why. A port in use says so there; set another `PORT` in the config file.
- **It stops when you log out (Linux).** Run `loginctl enable-linger $USER` once.
- **Search says meaning search is unavailable.** The model is still downloading, or huggingface.co could not be reached. `slipbox status` shows the model's state and last error; word search works meanwhile. Intel Macs always search by words only.
- **An agent gets 401.** The key is wrong or revoked; `slipbox key list` shows which keys exist.

## Uninstall

```sh
slipbox service uninstall
rm ~/.local/bin/slipbox
rm -rf ~/.local/share/slipbox ~/.config/slipbox   # your notes, keys and config: back them up first
```

On macOS, the service's log is `~/Library/Logs/slipbox.log`.

## Development

You need [Bun](https://bun.sh) (the version in `.bun-version`) and git.

```sh
bun install
bun run serve                 # the server from source
bun test                      # the tests on SQLite
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test   # and on Postgres
bun run typecheck
bun run build                 # dist/slipbox, with web/ built and embedded when present
```

Each Postgres test run creates and drops its own databases, so the URL only needs a user that may create them. The tests that use the real model download it once into your temp folder.

The server is in `server/`, the dashboard in `web/`, and [DESIGN.md](DESIGN.md) describes both. See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT. The program bundles third-party code under its own licenses, listed in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and shipped with every release.
