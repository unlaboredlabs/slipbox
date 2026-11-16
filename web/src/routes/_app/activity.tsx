import { useMemo } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ActivityIcon } from "lucide-react";
import { api, type ActivityEvent } from "@/lib/api";
import { arrivedAt, eventsQuery, useLive } from "@/lib/live";
import { cn, formatDate, formatDayTime, formatTime, isToday } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, TableSkeleton } from "@/components/data-table";
import { ErrorState, PageHeader, Placeholder } from "@/components/states";

type ActivitySearch = { agent?: string; action?: string };

export const Route = createFileRoute("/_app/activity")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => ({
    agent: typeof search.agent === "string" && search.agent ? search.agent : undefined,
    action: typeof search.action === "string" && search.action ? search.action : undefined,
  }),
  component: ActivityPage,
});

const column = createColumnHelper<ActivityEvent>();

// Plain titles rather than tooltips: a burst of events renders a thousand rows a few times a second.
const columns = [
  column.accessor("at", {
    header: "Time",
    meta: { width: 140 },
    cell: ({ getValue }) => {
      const at = getValue();
      return (
        <span title={formatDate(at)} className="text-muted-foreground tabular-nums">
          {isToday(at) ? formatTime(at) : formatDayTime(at)}
        </span>
      );
    },
  }),
  column.accessor("agent", { header: "Agent", meta: { width: 150 }, cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> }),
  column.accessor("action", {
    header: "Action",
    meta: { width: 120 },
    cell: ({ row }) => (
      <span className="flex items-center gap-2 text-muted-foreground">
        <span title={row.original.ok ? "Succeeded" : "Failed"} className={cn("size-1.5 shrink-0 rounded-full", row.original.ok ? "bg-ok/70" : "bg-destructive")} />
        {row.original.action}
        {!row.original.ok && <span className="sr-only">(failed)</span>}
      </span>
    ),
  }),
  column.display({
    id: "target",
    header: "Path or query",
    cell: ({ row }) => (
      <span className="block truncate">
        <Target event={row.original} />
      </span>
    ),
  }),
];

function Target({ event }: { event: ActivityEvent }) {
  if (event.query) return <span className="text-foreground/80">“{event.query}”{event.path && <span className="text-muted-foreground"> in {event.path}</span>}</span>;
  if (event.path?.endsWith(".md"))
    return (
      <Link to="/files" search={{ path: event.path }} className="text-link hover:underline">
        {event.path}
      </Link>
    );
  if (event.path) return <span className="text-foreground/80">{event.path}</span>;
  return <span className="text-muted-foreground">—</span>;
}

const ALL = "__all";

function ActivityPage() {
  const { agent, action } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // One agent's events come from the server, so the filter reaches past the latest rows.
  const { data, isPending, error, refetch } = useQuery(eventsQuery(agent));
  const live = useLive();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const agentNames = useMemo(
    () => [...new Set([...(agents.data?.agents.map((a) => a.name) ?? []), ...(data?.map((e) => e.agent) ?? [])])].sort(),
    [agents.data, data],
  );
  const actions = useMemo(() => [...new Set(data?.map((e) => e.action) ?? [])].sort(), [data]);
  const rows = useMemo(() => (data ?? []).filter((e) => !action || e.action === action), [data, action]);

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), autoResetPageIndex: false, getRowId: (e) => String(e.id) });
  const setFilter = (patch: ActivitySearch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            Activity
            <Hint label={live ? "Receiving new events" : "Reconnecting…"}>
              <span className={cn("size-1.5 rounded-full", live ? "bg-ok animate-pulse" : "bg-muted-foreground/40")} aria-label={live ? "Live" : "Offline"} />
            </Hint>
          </span>
        }
      >
        <FilterSelect value={agent} onChange={(v) => setFilter({ agent: v })} all="All agents" options={agentNames} />
        <FilterSelect value={action} onChange={(v) => setFilter({ action: v })} all="All actions" options={actions} />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
        {isPending ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : data.length === 0 && !agent ? (
          <Placeholder icon={ActivityIcon} title="No activity yet" />
        ) : rows.length === 0 ? (
          <Placeholder title="Nothing matches these filters">
            <Button variant="outline" size="sm" onClick={() => setFilter({ agent: undefined, action: undefined })}>
              Clear filters
            </Button>
          </Placeholder>
        ) : (
          <DataTable table={table} rowClassName={(e) => (Date.now() - (arrivedAt.get(e.id) ?? 0) < 1600 ? "row-in" : undefined)} />
        )}
      </div>
    </>
  );
}

function FilterSelect({ value, onChange, all, options }: { value?: string; onChange: (value?: string) => void; all: string; options: string[] }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className={cn("w-36", value && "text-foreground")} aria-label={all}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={ALL}>{all}</SelectItem>
        {/* Keep a filter from a link selectable even before an event of its kind has loaded. */}
        {[...new Set([...options, ...(value ? [value] : [])])].map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
