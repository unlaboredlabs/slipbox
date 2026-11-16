import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { api, type TreeEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/ui/tooltip";
import { Placeholder } from "@/components/states";

/** Folders of a file path: "a/b/c.md" gives ["a/", "a/b/"]. */
function ancestors(path?: string) {
  if (!path) return [];
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`);
}

export const treeKey = (path: string) => ["tree", path] as const;

export function FileTree({ selected }: { selected?: string }) {
  const [open, setOpen] = useState(() => new Set(ancestors(selected)));
  const [seen, setSeen] = useState(selected);
  // Opening a file from elsewhere (Activity, Search) unfolds its folders.
  if (selected !== seen) {
    setSeen(selected);
    const missing = ancestors(selected).filter((dir) => !open.has(dir));
    if (missing.length) setOpen(new Set([...open, ...missing]));
  }

  const toggle = (dir: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  return (
    // Plain links and buttons in Tab order: no tree role, as there is no arrow-key navigation.
    <div className="flex flex-col gap-px">
      <Folder path="" depth={0} open={open} toggle={toggle} selected={selected} />
    </div>
  );
}

type FolderProps = { path: string; depth: number; open: Set<string>; toggle: (dir: string) => void; selected?: string };

function Folder({ path, depth, open, toggle, selected }: FolderProps) {
  const { data, isPending, error, refetch } = useQuery({ queryKey: treeKey(path), queryFn: () => api.tree(path) });

  if (isPending) {
    return (
      <div className="flex flex-col gap-1.5 py-1" style={{ paddingLeft: indent(depth) }}>
        {[0.7, 0.5, 0.6].slice(0, depth ? 2 : 3).map((w, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${w * 100}%` }} />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <button type="button" onClick={() => refetch()} className="py-1 text-left text-xs text-muted-foreground hover:text-foreground" style={{ paddingLeft: indent(depth) }}>
        {error.message} · <span className="text-link">Retry</span>
      </button>
    );
  }
  if (!data.entries.length) return depth ? null : <Placeholder title="No files yet" />;

  return sorted(data.entries).map((entry) =>
    entry.type === "dir" ? (
      <div key={entry.path} className="flex flex-col gap-px">
        <Row entry={entry} depth={depth} expanded={open.has(entry.path)} onToggle={() => toggle(entry.path)} />
        {open.has(entry.path) && <Folder {...{ open, toggle, selected }} path={entry.path} depth={depth + 1} />}
      </div>
    ) : (
      <Row key={entry.path} entry={entry} depth={depth} selected={entry.path === selected} />
    ),
  );
}

const names = new Intl.Collator(undefined, { numeric: true });
/** Folders first, then files, by name with numbers in order: topic-2 before topic-10. */
const sorted = (entries: TreeEntry[]) =>
  [...entries].sort((a, b) => (a.type === b.type ? names.compare(a.name, b.name) : a.type === "dir" ? -1 : 1));

const indent = (depth: number) => 8 + depth * 14;

const rowClass =
  "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-[13px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground";

function Row({
  entry,
  depth,
  expanded,
  onToggle,
  selected,
}: {
  entry: TreeEntry;
  depth: number;
  expanded?: boolean;
  onToggle?: () => void;
  selected?: boolean;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  // A file opened from a link or from elsewhere is scrolled into view.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (entry.type === "dir") {
    return (
      <Hint label={entry.summary} side="right">
        <button type="button" aria-expanded={expanded} onClick={onToggle} className={rowClass} style={{ paddingLeft: indent(depth) - 4 }}>
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")} />
          <span className="truncate">{entry.name}</span>
        </button>
      </Hint>
    );
  }
  return (
    <Hint label={entry.summary} side="right">
      <Link
        to="/files"
        ref={ref}
        search={{ path: entry.path }}
        aria-current={selected ? "page" : undefined}
        className={cn(rowClass, selected && "bg-accent font-medium text-foreground")}
        style={{ paddingLeft: indent(depth) + 14 }}
      >
        <span className="truncate">{entry.name.replace(/\.md$/, "")}</span>
      </Link>
    </Hint>
  );
}
