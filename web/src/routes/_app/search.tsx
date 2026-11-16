import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, SearchIcon, SearchXIcon } from "lucide-react";
import { api, type SearchResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/ui/tooltip";
import { ErrorState, PageHeader, Placeholder } from "@/components/states";

type SearchParams = { q?: string; path?: string };

export const Route = createFileRoute("/_app/search")({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
    path: typeof search.path === "string" && search.path.trim() ? search.path : undefined,
  }),
  component: SearchPage,
});

function SearchPage() {
  const { q, path } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState(q ?? "");
  const [prefix, setPrefix] = useState(path ?? "");

  const results = useQuery({
    queryKey: ["search", q, path],
    // No limit: the server's default, the number an agent gets.
    queryFn: () => api.search(q!, path),
    enabled: Boolean(q),
    staleTime: 0,
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    navigate({ search: { q: query.trim() || undefined, path: prefix.trim() || undefined } });
    if (query.trim() === q && (prefix.trim() || undefined) === path) results.refetch();
  }

  return (
    <>
      <PageHeader title="Search">
        <IndexHealth />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="w-full max-w-[820px] px-6 pt-2">
          <form onSubmit={submit} className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Query"
                autoFocus
                className="h-10 rounded-lg pl-9 text-sm"
              />
            </div>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="Path"
              aria-label="Path prefix"
              spellCheck={false}
              autoCapitalize="off"
              className="h-10 w-48 rounded-lg text-sm"
            />
            <button type="submit" className="sr-only">
              Search
            </button>
          </form>

          <div className="mt-6">
            {!q ? null : results.isPending ? (
              <ResultsSkeleton />
            ) : results.error ? (
              <ErrorState error={results.error} onRetry={results.refetch} />
            ) : (
              <>
                {results.data.meaning === "unavailable" && (
                  <p className="mb-3 flex items-center gap-2 text-[13px] text-muted-foreground">
                    <CircleAlertIcon className="size-3.5" />
                    Meaning search unavailable, matched by words only
                  </p>
                )}
                {results.data.results.length === 0 ? (
                  <Placeholder icon={SearchXIcon} title="No matches" />
                ) : (
                  <ol className="-mx-3 flex flex-col gap-1">
                    {results.data.results.map((r) => (
                      <li key={`${r.path}:${r.startLine}`}>
                        <Result result={r} />
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Result({ result }: { result: SearchResult }) {
  return (
    <Link to="/files" search={{ path: result.path, lines: `${result.startLine}-${result.endLine}` }} className="group flex flex-col gap-1 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/70">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-[13.5px]">
          <span className="text-link group-hover:underline">{result.path}</span>
          {result.heading && <span className="text-muted-foreground"> › {result.heading}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Match label="words" rank={result.wordRank} />
          <Match label="meaning" rank={result.meaningRank} />
          <Hint label={`Score ${result.score}`}>
            <span className="ml-1 font-mono text-[11.5px] text-muted-foreground tabular-nums">
              {result.startLine === result.endLine ? `L${result.startLine}` : `L${result.startLine}–${result.endLine}`}
            </span>
          </Hint>
        </span>
      </div>
      <p className="line-clamp-3 text-[13px] leading-relaxed text-foreground/70">{result.snippet}</p>
    </Link>
  );
}

/** Shows that a result came from the word or meaning index, with its rank there on hover. */
function Match({ label, rank }: { label: string; rank: number | null }) {
  if (rank === null) return null;
  return (
    <Hint label={`#${rank} by ${label}`}>
      <span className="rounded-[5px] bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{label}</span>
    </Hint>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-6 px-3 pt-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ))}
    </div>
  );
}

const number = new Intl.NumberFormat();

function IndexHealth() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), refetchInterval: 5000 });
  if (health.isPending) return <Skeleton className="h-4 w-56" />;
  if (health.error) return <span className="text-xs text-destructive">Index health unavailable</span>;

  const { embed } = health.data;
  if (embed.model === "off") return <span className="text-xs text-muted-foreground">Meaning search off</span>;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <Hint label={embed.model}>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", embed.loaded ? "bg-ok" : "bg-muted-foreground/40")} />
          {embed.loaded ? "Model loaded" : "Model not loaded"}
        </span>
      </Hint>
      <Dot />
      <span>
        {number.format(embed.embedded)} of {number.format(embed.total)} embedded
      </span>
      {embed.queued > 0 && (
        <>
          <Dot />
          <span>{number.format(embed.queued)} queued</span>
        </>
      )}
      {embed.lastError && (
        <Hint label={embed.lastError}>
          <CircleAlertIcon className="ml-1 size-3.5 text-destructive" aria-label={`Last error: ${embed.lastError}`} />
        </Hint>
      )}
    </div>
  );
}

const Dot = () => <span className="text-muted-foreground/40">·</span>;
