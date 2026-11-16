import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, HistoryIcon, LoaderIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { ApiError, api, type FileDoc, type Version } from "@/lib/api";
import { cn, formatBytes, formatDate, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ErrorState, Placeholder } from "@/components/states";
import { FileTree } from "@/components/files/tree";
import { MarkdownView } from "@/components/files/markdown";
import { DiffView } from "@/components/files/diff";

/** `lines` ("12-30") scrolls the note to a search result. */
type FilesSearch = { path?: string; commit?: string; lines?: string };

export const Route = createFileRoute("/_app/files")({
  validateSearch: (search: Record<string, unknown>): FilesSearch => ({
    path: typeof search.path === "string" && search.path ? search.path : undefined,
    commit: typeof search.commit === "string" && search.commit ? search.commit : undefined,
    lines: typeof search.lines === "string" && /^\d+(-\d+)?$/.test(search.lines) ? search.lines : undefined,
  }),
  component: FilesPage,
});

const HISTORY_OPEN = "historyOpen";

function FilesPage() {
  const { path, commit, lines } = Route.useSearch();
  const [historyOpen, setHistoryOpen] = useState(() => localStorage.getItem(HISTORY_OPEN) === "1");
  const showHistory = Boolean(path) && (historyOpen || Boolean(commit));
  const navigate = useNavigate({ from: Route.fullPath });

  function toggleHistory() {
    const next = !showHistory;
    localStorage.setItem(HISTORY_OPEN, next ? "1" : "0");
    setHistoryOpen(next);
    if (!next && commit) navigate({ search: { path } });
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col overflow-y-auto px-2 pt-4 pb-6 max-md:w-48">
        <FileTree selected={path} />
      </aside>
      {path ? (
        <OpenFile key={path} path={path} commit={commit} lines={lines} historyOpen={showHistory} onToggleHistory={toggleHistory} />
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <Placeholder icon={FileTextIcon} title="Choose a file" />
        </section>
      )}
    </div>
  );
}

// History loads a page of versions plus one more: the extra one is the base of the last row's diff.
const PAGE = 100;
const MAX = 999; // the server returns at most 1000

const historyQuery = (path: string, limit: number) =>
  queryOptions({ queryKey: ["history", path, limit], queryFn: () => api.history(path, limit + 1), placeholderData: keepPreviousData });

type OpenFileProps = { path: string; commit?: string; lines?: string; historyOpen: boolean; onToggleHistory: () => void };

function OpenFile(props: OpenFileProps) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col">
        <FileView {...props} limit={limit} />
      </section>
      {props.historyOpen && (
        <HistoryPanel path={props.path} selected={props.commit} limit={limit} onMore={() => setLimit(Math.min(MAX, limit + PAGE))} onClose={props.onToggleHistory} />
      )}
    </>
  );
}

function FileView({ path, commit, lines, historyOpen, onToggleHistory, limit }: OpenFileProps & { limit: number }) {
  const file = useQuery({ queryKey: ["file", path], queryFn: () => api.file(path) });
  // Deep paths keep the first and last two folders: "projects / … / shop / profile.md".
  const folders = path.split("/").slice(0, -1);
  const segments = [...(folders.length > 3 ? [folders[0], "…", ...folders.slice(-2)] : folders), path.split("/").pop()!];

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 px-6">
        {/* Only the file name shrinks: folders are short, and a sliver taken from each would cut them all. */}
        <nav className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] text-muted-foreground">
          {segments.map((segment, i) => {
            const last = i === segments.length - 1;
            return (
              <span key={i} className={cn("flex items-center gap-1.5", last ? "min-w-[8ch]" : "max-w-36 shrink-0")}>
                {i > 0 && <span className="text-muted-foreground/40">/</span>}
                <span className={cn("truncate", last && "text-foreground")} title={last ? path : undefined}>
                  {segment}
                </span>
              </span>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {file.data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatBytes(file.data.bytes)}
              {file.data.updatedAt && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  <Hint label={formatDate(file.data.updatedAt)}>
                    <span>{timeAgo(file.data.updatedAt)}</span>
                  </Hint>
                </>
              )}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onToggleHistory} className={cn(historyOpen && "bg-accent text-foreground")} aria-pressed={historyOpen}>
            <HistoryIcon className="size-3.5" />
            History
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {commit ? (
          <VersionDiff path={path} commit={commit} limit={limit} />
        ) : file.isPending ? (
          <FileSkeleton />
        ) : file.error ? (
          file.error instanceof ApiError && file.error.status === 404 ? (
            <Missing path={path} error={file.error} limit={limit} />
          ) : (
            <ErrorState error={file.error} onRetry={file.refetch} />
          )
        ) : (
          <Document doc={file.data} lines={lines} />
        )}
      </div>
    </>
  );
}

function Document({ doc, lines }: { doc: FileDoc; lines?: string }) {
  return (
    <article className="mx-auto w-full max-w-[720px] px-8 pt-6 pb-24">
      <h1 className="mb-5 text-[26px] leading-tight font-semibold tracking-[-0.02em] [overflow-wrap:anywhere]">{doc.title || doc.path.split("/").pop()}</h1>
      {doc.content.trim() ? (
        <MarkdownView content={doc.content} path={doc.path} skipTitle={Boolean(doc.title)} lines={lines} />
      ) : (
        <p className="text-muted-foreground">Empty file</p>
      )}
    </article>
  );
}

/** A file that isn't there: if an agent deleted it, says who and when and leads to the last version, which can be restored. */
function Missing({ path, error, limit }: { path: string; error: ApiError; limit: number }) {
  const history = useQuery(historyQuery(path, limit));
  const navigate = useNavigate({ from: Route.fullPath });
  const [head, before] = history.data?.versions ?? [];
  if (history.isPending) return <FileSkeleton />;
  if (head?.version !== null || !before) return <ErrorState error={error} />;
  return (
    <Placeholder icon={Trash2Icon} title={`Deleted by ${head.agent} ${timeAgo(head.at)}`}>
      <Button variant="outline" size="sm" onClick={() => navigate({ search: { path, commit: before.commit } })}>
        <HistoryIcon className="size-3.5" />
        Last version
      </Button>
    </Placeholder>
  );
}

function FileSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-8 pt-8">
      <Skeleton className="mb-4 h-7 w-56" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

function HistoryPanel({
  path,
  selected,
  limit,
  onMore,
  onClose,
}: {
  path: string;
  selected?: string;
  limit: number;
  onMore: () => void;
  onClose: () => void;
}) {
  const history = useQuery(historyQuery(path, limit));
  const versions = history.data?.versions.slice(0, limit) ?? [];
  const more = (history.data?.versions.length ?? 0) > limit && limit < MAX;

  // Below xl it lies over the note rather than squeezing it.
  return (
    <aside className="flex w-72 shrink-0 flex-col max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-20 max-xl:bg-popover max-xl:shadow-xl max-md:w-64">
      <header className="flex h-14 shrink-0 items-center justify-between pr-3 pl-5">
        <h2 className="text-[13px] font-medium">History</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close history">
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pr-3 pl-2 pb-6">
        {history.isPending ? (
          <div className="flex flex-col gap-4 px-3 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            ))}
          </div>
        ) : history.error ? (
          <ErrorState error={history.error} onRetry={history.refetch} />
        ) : versions.length === 0 ? (
          <Placeholder title="No history" />
        ) : (
          <ol className="flex flex-col gap-px">
            {versions.map((v, i) => (
              <li key={v.commit}>
                <VersionRow version={v} path={path} current={i === 0} selected={v.commit === selected} />
              </li>
            ))}
            {more && (
              <li>
                <button
                  type="button"
                  onClick={onMore}
                  disabled={history.isFetching}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {history.isFetching && <LoaderIcon className="size-3.5 animate-spin" />}
                  Show older
                </button>
              </li>
            )}
          </ol>
        )}
      </div>
    </aside>
  );
}

function VersionRow({ version, path, current, selected }: { version: Version; path: string; current: boolean; selected: boolean }) {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <button
      type="button"
      onClick={() => navigate({ search: { path, commit: selected ? undefined : version.commit } })}
      className={cn("flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent", selected && "bg-accent")}
    >
      <span className="line-clamp-2 text-[13px] leading-snug">{version.why || "No message"}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{version.agent}</span>
        <span className="text-muted-foreground/40">·</span>
        <Hint label={formatDate(version.at)}>
          <span className="shrink-0">{timeAgo(version.at)}</span>
        </Hint>
        {version.version === null ? (
          <span className="ml-auto shrink-0 text-[11px] text-removed-strong">Deleted</span>
        ) : (
          current && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Current</span>
        )}
      </span>
    </button>
  );
}

function VersionDiff({ path, commit, limit }: { path: string; commit: string; limit: number }) {
  const history = useQuery(historyQuery(path, limit));
  const versions = history.data?.versions ?? [];
  const index = versions.findIndex((v) => v.commit === commit);
  const version = versions[index];
  const previous = versions[index + 1];

  const diff = useQuery({
    queryKey: ["diff", path, previous?.commit, commit],
    queryFn: () => api.diff(path, previous?.commit, commit),
    enabled: Boolean(version),
  });

  if (history.isPending) return <FileSkeleton />;
  if (history.error) return <ErrorState error={history.error} onRetry={history.refetch} />;
  if (!version) return <Placeholder title="This version isn't in the file's history" />;

  return (
    <div className="mx-auto w-full max-w-[880px] px-8 pt-4 pb-24">
      <div className="mb-5 flex items-start gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[17px] leading-snug font-semibold tracking-[-0.01em]">{version.why || "No message"}</h1>
          <p className="text-[13px] text-muted-foreground">
            {version.agent}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            {formatDate(version.at)}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            <span className="font-mono text-xs">{commit.slice(0, 7)}</span>
          </p>
        </div>
        {index > 0 && version.version !== null && <RestoreButton path={path} version={version} />}
      </div>
      {diff.isPending ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : diff.error ? (
        <ErrorState error={diff.error} onRetry={diff.refetch} />
      ) : (
        <DiffView diff={diff.data.diff} />
      )}
    </div>
  );
}

function RestoreButton({ path, version }: { path: string; version: Version }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });

  const restore = useMutation({
    mutationFn: () => api.restore(path, version.commit),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["file", path] }),
        queryClient.invalidateQueries({ queryKey: ["history", path] }),
        queryClient.invalidateQueries({ queryKey: ["tree"] }),
      ]);
      setOpen(false);
      navigate({ search: { path } });
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !restore.isPending && (setOpen(next), restore.reset())}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <RotateCcwIcon className="size-3.5" />
          Restore
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this version?</AlertDialogTitle>
          <AlertDialogDescription>
            {path} goes back to the text from {formatDate(version.at)}, saved as a new version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {restore.error && <p className="text-[13px] text-destructive">{restore.error.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={restore.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={restore.isPending}
            onClick={(event) => {
              event.preventDefault();
              restore.mutate();
            }}
          >
            {restore.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
