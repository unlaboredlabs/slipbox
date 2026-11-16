import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, HistoryIcon, LoaderIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { api, type FileDoc, type Version } from "@/lib/api";
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
} from "@/components/ui/alert-dialog";
import { ErrorState, Placeholder } from "@/components/states";
import { FileTree } from "@/components/files/tree";
import { MarkdownView } from "@/components/files/markdown";
import { DiffView } from "@/components/files/diff";

type FilesSearch = { path?: string; commit?: string };

export const Route = createFileRoute("/_app/files")({
  validateSearch: (search: Record<string, unknown>): FilesSearch => ({
    path: typeof search.path === "string" && search.path ? search.path : undefined,
    commit: typeof search.commit === "string" && search.commit ? search.commit : undefined,
  }),
  component: FilesPage,
});

const HISTORY_OPEN = "historyOpen";

function FilesPage() {
  const { path, commit } = Route.useSearch();
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
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col overflow-y-auto px-2 pt-4 pb-6">
        <FileTree selected={path} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {path ? (
          <FileView key={path} path={path} commit={commit} historyOpen={showHistory} onToggleHistory={toggleHistory} />
        ) : (
          <Placeholder icon={FileTextIcon} title="Choose a file" />
        )}
      </section>
      {path && showHistory && <HistoryPanel path={path} selected={commit} onClose={toggleHistory} />}
    </div>
  );
}

function FileView({
  path,
  commit,
  historyOpen,
  onToggleHistory,
}: {
  path: string;
  commit?: string;
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const file = useQuery({ queryKey: ["file", path], queryFn: () => api.file(path) });
  const segments = path.split("/");

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 px-6">
        <nav className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {segments.map((segment, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground/40">/</span>}
              <span className={cn("truncate", i === segments.length - 1 && "text-foreground")}>{segment}</span>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {file.data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatBytes(file.data.bytes)}
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              <Hint label={formatDate(file.data.updatedAt)}>
                <span>{timeAgo(file.data.updatedAt)}</span>
              </Hint>
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
          <VersionDiff path={path} commit={commit} />
        ) : file.isPending ? (
          <FileSkeleton />
        ) : file.error ? (
          <ErrorState error={file.error} onRetry={file.refetch} />
        ) : (
          <Document doc={file.data} />
        )}
      </div>
    </>
  );
}

function Document({ doc }: { doc: FileDoc }) {
  return (
    <article className="mx-auto w-full max-w-[720px] px-8 pt-6 pb-24">
      <h1 className="mb-5 text-[26px] leading-tight font-semibold tracking-[-0.02em]">{doc.title || doc.path.split("/").pop()}</h1>
      {doc.content.trim() ? <MarkdownView content={doc.content} skipTitle={Boolean(doc.title)} /> : <p className="text-muted-foreground">Empty file</p>}
    </article>
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

const historyKey = (path: string) => ["history", path] as const;

function HistoryPanel({ path, selected, onClose }: { path: string; selected?: string; onClose: () => void }) {
  const history = useQuery({ queryKey: historyKey(path), queryFn: () => api.history(path) });

  return (
    <aside className="flex w-72 shrink-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between pr-3 pl-5">
        <h2 className="text-[13px] font-medium">History</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close history">
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
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
        ) : history.data.versions.length === 0 ? (
          <Placeholder title="No history" />
        ) : (
          <ol className="flex flex-col gap-px">
            {history.data.versions.map((v, i) => (
              <li key={v.commit}>
                <VersionRow version={v} path={path} current={i === 0} selected={v.commit === selected} />
              </li>
            ))}
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
        {current && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/80">Current</span>}
      </span>
    </button>
  );
}

function VersionDiff({ path, commit }: { path: string; commit: string }) {
  const history = useQuery({ queryKey: historyKey(path), queryFn: () => api.history(path) });
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
        {index > 0 && <RestoreButton path={path} version={version} />}
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
        queryClient.invalidateQueries({ queryKey: historyKey(path) }),
        queryClient.invalidateQueries({ queryKey: ["tree"] }),
      ]);
      setOpen(false);
      navigate({ search: { path } });
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !restore.isPending && (setOpen(next), restore.reset())}>
      <Button variant="outline" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
        <RotateCcwIcon className="size-3.5" />
        Restore
      </Button>
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
