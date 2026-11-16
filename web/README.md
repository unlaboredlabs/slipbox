# Dashboard

The read-only dashboard: Files, Activity, Agents and Search. Vite, React, TanStack Router, Query and Table, shadcn/ui on Tailwind. The server serves the built files at `/`.

```
bun install
bun run mock     # a mock of the /api in DESIGN.md on port 7323, admin token "dev"
bun run dev      # http://localhost:5173, /api proxied to PORT (default 7323)
bun run build    # type-checks, then writes static files to dist/
```

Run `bun run dev` against the real server instead of the mock by starting the server on port 7323, or set `PORT`. `MEANING=off bun run mock` answers search by words only.

The product name lives in `src/lib/config.ts`.
