import { useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ActivityIcon } from "lucide-react";
import { api, followEvents, type ActivityEvent } from "@/lib/api";
import { cn, formatDate, formatTime, isToday } from "@/lib/utils";
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

const EVENTS_KEY = ["events"] as const;
const KEEP = 1000;

/** Merges events newest first, without duplicates, keeping the latest KEEP. */
function merge(current: ActivityEvent[] | undefined, incoming: ActivityEvent[]) {
  const byId = new Map((current ?? []).map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, KEEP);
}

/** Loads recent events, then keeps them current from the stream. */
function useLiveEvents() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const fresh = useRef(new Set<number>());

  const query = useQuery({
    queryKey: EVENTS_KEY,
    queryFn: async () => (await api.events({ limit: 500 })).events,
    staleTime: Infinity,
  });

  useEffect(() => {
    const add = (incoming: ActivityEvent[], highlight: boolean) => {
      if (highlight) for (const e of incoming) fresh.current.add(e.id);
      queryClient.setQueryData<ActivityEvent[]>(EVENTS_KEY, (current) => (current ? merge(current, incoming) : current));
    };
    return followEvents({
      onEvent: (event) => add([event], true),
      onStatus: setLive,
      // Fill anything missed before the stream opened, or while it was down.
      onOpen: async () => {
        const latest = queryClient.getQueryData<ActivityEvent[]>(EVENTS_KEY)?.[0]?.id;
        if (latest === undefined) return;
        const { events } = await api.events({ after: latest, limit: 500 }).catch(() => ({ events: [] }));
        add(events, true);
      },
    });
  }, [queryClient]);

  return { ...query, live, fresh: fresh.current };
}

const column = createColumnHelper<ActivityEvent>();

const columns = [
  column.accessor("at", {
    header: "Time",
    meta: { width: 120 },
    cell: ({ getValue }) => {
      const at = getValue();
      return (
        <Hint label={formatDate(at)}>
          <span className="text-muted-foreground tabular-nums">
            {isToday(at) ? formatTime(at) : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
        </Hint>
      );
    },
  }),
  column.accessor("agent", { header: "Agent", meta: { width: 150 }, cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> }),
  column.accessor("action", { header: "Action", meta: { width: 110 }, cell: ({ getValue }) => <span className="text-muted-foreground">{getValue()}</span> }),
  column.display({
    id: "target",
    header: "Path or query",
    cell: ({ row }) => (
      <span className="block truncate">
        <Target event={row.original} />
      </span>
    ),
  }),
  column.accessor("ok", {
    header: () => <span className="sr-only">Result</span>,
    meta: { width: 44 },
    cell: ({ getValue }) => (
      <Hint label={getValue() ? "Succeeded" : "Failed"}>
        <span className="flex justify-center">
          <span className={cn("size-1.5 rounded-full", getValue() ? "bg-ok/70" : "bg-destructive")} />
        </span>
      </Hint>
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
  return <span className="text-muted-foreground/50">—</span>;
}

const ALL = "__all";

function ActivityPage() {
  const { agent, action } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isPending, error, refetch, live, fresh } = useLiveEvents();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const agentNames = useMemo(
    () => [...new Set([...(agents.data?.agents.map((a) => a.name) ?? []), ...(data?.map((e) => e.agent) ?? [])])].sort(),
    [agents.data, data],
  );
  const actions = useMemo(() => [...new Set(data?.map((e) => e.action) ?? [])].sort(), [data]);
  const rows = useMemo(() => (data ?? []).filter((e) => (!agent || e.agent === agent) && (!action || e.action === action)), [data, agent, action]);

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
        ) : data.length === 0 ? (
          <Placeholder icon={ActivityIcon} title="No activity yet" />
        ) : rows.length === 0 ? (
          <Placeholder title="Nothing matches these filters">
            <Button variant="outline" size="sm" onClick={() => setFilter({ agent: undefined, action: undefined })}>
              Clear filters
            </Button>
          </Placeholder>
        ) : (
          <DataTable table={table} rowClassName={(e) => (fresh.has(e.id) ? "row-in" : undefined)} />
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
