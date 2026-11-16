import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { BanIcon, CheckIcon, CopyIcon, KeyRoundIcon, LoaderIcon, MoreHorizontalIcon, PencilIcon, PlusIcon } from "lucide-react";
import { api, type Agent } from "@/lib/api";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DataTable, TableSkeleton } from "@/components/data-table";
import { ErrorState, PageHeader, Placeholder } from "@/components/states";
import { GrantsEditor, cleanGrants, draftGrants, newGrant, type GrantDraft } from "@/components/agents/grants-editor";

export const Route = createFileRoute("/_app/agents")({ component: AgentsPage });

const AGENTS_KEY = ["agents"] as const;

type Dialogs = { kind: "create" } | { kind: "edit"; agent: Agent } | { kind: "revoke"; agent: Agent } | null;

const column = createColumnHelper<Agent>();

function agentColumns(open: (dialog: Dialogs) => void) {
  return [
    column.accessor("name", { header: "Name", meta: { width: 180 }, cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> }),
    column.accessor("grants", {
      header: "Grants",
      cell: ({ getValue }) => <Grants grants={getValue()} />,
    }),
    column.accessor("lastSeenAt", {
      header: "Last seen",
      meta: { width: 130 },
      cell: ({ getValue }) => (
        <Hint label={getValue() ? formatDate(getValue()) : undefined}>
          <span className="text-muted-foreground">{timeAgo(getValue())}</span>
        </Hint>
      ),
    }),
    column.accessor("revoked", {
      header: "State",
      meta: { width: 100 },
      cell: ({ getValue }) => <span className={cn(getValue() ? "text-muted-foreground" : "text-foreground/80")}>{getValue() ? "Revoked" : "Active"}</span>,
    }),
    column.display({
      id: "actions",
      meta: { width: 56 },
      cell: ({ row }) =>
        row.original.revoked ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} className="opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => open({ kind: "edit", agent: row.original })}>
                <PencilIcon />
                Edit grants
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => open({ kind: "revoke", agent: row.original })}>
                <BanIcon />
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    }),
  ];
}

function AgentsPage() {
  const agents = useQuery({ queryKey: AGENTS_KEY, queryFn: api.agents, refetchInterval: 30_000 });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);

  // Table data and columns must keep their identity between renders: new arrays make
  // TanStack Table reset its state, which renders again, which never ends.
  const rows = useMemo(
    () => [...(agents.data?.agents ?? [])].sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name)),
    [agents.data],
  );
  const columns = useMemo(() => agentColumns(setDialog), []);

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), autoResetPageIndex: false, getRowId: (a) => a.id });

  return (
    <>
      <PageHeader title="Agents">
        <Hint label="New key">
          <Button variant="ghost" size="icon-sm" aria-label="New key" onClick={() => setDialog({ kind: "create" })}>
            <PlusIcon />
          </Button>
        </Hint>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
        {agents.isPending ? (
          <TableSkeleton />
        ) : agents.error ? (
          <ErrorState error={agents.error} onRetry={agents.refetch} />
        ) : rows.length === 0 ? (
          <Placeholder icon={KeyRoundIcon} title="No agents yet">
            <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "create" })}>
              <PlusIcon className="size-3.5" />
              New key
            </Button>
          </Placeholder>
        ) : (
          <DataTable table={table} rowClassName={(a) => (a.revoked ? "text-muted-foreground [&_.font-medium]:font-normal" : undefined)} />
        )}
      </div>

      <Dialog open={dialog?.kind === "create"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "create" && <CreateKey onDone={close} />}
      </Dialog>
      <Dialog open={dialog?.kind === "edit"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "edit" && <EditGrants agent={dialog.agent} onDone={close} />}
      </Dialog>
      <AlertDialog open={dialog?.kind === "revoke"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "revoke" && <Revoke agent={dialog.agent} onDone={close} />}
      </AlertDialog>
    </>
  );
}

function Grants({ grants }: { grants: Agent["grants"] }) {
  if (!grants.length) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {grants.map((g) => (
        <span key={g.prefix} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 text-xs">
          {g.prefix ? <span className="font-mono text-[11.5px]">{g.prefix}</span> : <span>everything</span>}
          <span className={cn(g.mode === "write" ? "text-foreground/70" : "text-muted-foreground")}>{g.mode}</span>
        </span>
      ))}
    </span>
  );
}

function useSaveAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
}

function CreateKey({ onDone }: { onDone: () => void }) {
  const refresh = useSaveAgents();
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<GrantDraft[]>(() => [{ ...newGrant(), prefix: "shared/" }]);
  const create = useMutation({ mutationFn: () => api.createAgent(name.trim(), cleanGrants(grants)), onSuccess: refresh });

  if (create.data) return <ShowKey name={create.data.agent.name} secret={create.data.key} onDone={onDone} />;

  return (
    <DialogContent>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <DialogHeader>
          <DialogTitle>New key</DialogTitle>
          <DialogDescription className="sr-only">Name the agent and choose which paths it may read or write.</DialogDescription>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name" aria-label="Agent name" autoFocus spellCheck={false} autoCapitalize="off" />
        <GrantsEditor value={grants} onChange={setGrants} />
        {create.error && <p className="text-[13px] text-destructive">{create.error.message}</p>}
        <DialogFooter>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            {create.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Create key
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ShowKey({ name, secret, onDone }: { name: string; secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (await copyText(secret)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <DialogContent onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Key for {name}</DialogTitle>
        <DialogDescription>It won't be shown again.</DialogDescription>
      </DialogHeader>
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all select-all">{secret}</code>
        <Button variant="ghost" size="sm" onClick={copy} className="text-foreground">
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** The clipboard API only exists on secure origins; plain http on a LAN address needs the old way. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function EditGrants({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const refresh = useSaveAgents();
  const [grants, setGrants] = useState(() => draftGrants(agent.grants));
  const save = useMutation({
    mutationFn: () => api.updateAgent(agent.id, { grants: cleanGrants(grants) }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  return (
    <DialogContent>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <DialogHeader>
          <DialogTitle>Grants for {agent.name}</DialogTitle>
          <DialogDescription className="sr-only">Choose which paths this agent may read or write.</DialogDescription>
        </DialogHeader>
        <GrantsEditor value={grants} onChange={setGrants} />
        {save.error && <p className="text-[13px] text-destructive">{save.error.message}</p>}
        <DialogFooter>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function Revoke({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const refresh = useSaveAgents();
  const revoke = useMutation({
    mutationFn: () => api.updateAgent(agent.id, { revoked: true }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Revoke {agent.name}?</AlertDialogTitle>
        <AlertDialogDescription>Its key stops working at once.</AlertDialogDescription>
      </AlertDialogHeader>
      {revoke.error && <p className="text-[13px] text-destructive">{revoke.error.message}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={revoke.isPending}
          onClick={(e) => {
            e.preventDefault();
            revoke.mutate();
          }}
        >
          {revoke.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
          Revoke
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
