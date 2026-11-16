import { useCallback, useMemo, useRef, useState } from "react";
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

type Open = (dialog: Dialogs, opener: HTMLElement | null) => void;

function agentColumns(open: Open) {
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
      // A revoked agent's name can be given to a new key: the date tells the two rows apart.
      cell: ({ row, getValue }) =>
        getValue() ? (
          <Hint label={`Created ${formatDate(row.original.createdAt)}`}>
            <span className="text-muted-foreground">Revoked</span>
          </Hint>
        ) : (
          <span className="text-foreground/80">Active</span>
        ),
    }),
    column.display({
      id: "actions",
      meta: { width: 56 },
      cell: ({ row }) => (row.original.revoked ? null : <RowActions agent={row.original} open={open} />),
    }),
  ];
}

function RowActions({ agent, open }: { agent: Agent; open: Open }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} variant="ghost" size="icon-sm" aria-label={`Actions for ${agent.name}`} className="opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => open({ kind: "edit", agent }, trigger.current)}>
          <PencilIcon />
          Edit grants
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => open({ kind: "revoke", agent }, trigger.current)}>
          <BanIcon />
          Revoke
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentsPage() {
  const agents = useQuery({ queryKey: AGENTS_KEY, queryFn: api.agents, refetchInterval: 30_000 });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);
  // Dialogs open from a menu or a button, not a dialog trigger: focus goes back to what opened them.
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback<Open>((next, from) => {
    opener.current = from;
    setDialog(next);
  }, []);
  const refocus = (event: Event) => {
    if (!opener.current?.isConnected) return;
    event.preventDefault();
    opener.current.focus();
  };

  // Table data and columns must keep their identity between renders: new arrays make
  // TanStack Table reset its state, which renders again, which never ends.
  const rows = useMemo(
    () => [...(agents.data?.agents ?? [])].sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name)),
    [agents.data],
  );
  const columns = useMemo(() => agentColumns(open), [open]);

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), autoResetPageIndex: false, getRowId: (a) => String(a.id) });

  return (
    <>
      <PageHeader title="Agents">
        <Hint label="New key">
          <Button variant="ghost" size="icon-sm" aria-label="New key" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>
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
            <Button variant="outline" size="sm" onClick={(e) => open({ kind: "create" }, e.currentTarget)}>
              <PlusIcon className="size-3.5" />
              New key
            </Button>
          </Placeholder>
        ) : (
          <DataTable table={table} rowClassName={(a) => (a.revoked ? "text-muted-foreground [&_.font-medium]:font-normal" : undefined)} />
        )}
      </div>

      <Dialog open={dialog?.kind === "create"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "create" && <CreateKey onDone={close} onCloseAutoFocus={refocus} />}
      </Dialog>
      <Dialog open={dialog?.kind === "edit"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "edit" && <EditGrants agent={dialog.agent} onDone={close} onCloseAutoFocus={refocus} />}
      </Dialog>
      <AlertDialog open={dialog?.kind === "revoke"} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === "revoke" && <Revoke agent={dialog.agent} onDone={close} onCloseAutoFocus={refocus} />}
      </AlertDialog>
    </>
  );
}

function Grants({ grants }: { grants: Agent["grants"] }) {
  if (!grants.length) return <span className="text-muted-foreground">—</span>;
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

type DialogProps = { onDone: () => void; onCloseAutoFocus: (event: Event) => void };

function CreateKey({ onDone, onCloseAutoFocus }: DialogProps) {
  const refresh = useSaveAgents();
  const [name, setName] = useState("");
  const [unnamed, setUnnamed] = useState(false);
  const [grants, setGrants] = useState<GrantDraft[]>(() => [{ ...newGrant(), prefix: "shared/" }]);
  const create = useMutation({ mutationFn: () => api.createAgent(name.trim(), cleanGrants(grants)), onSuccess: refresh });

  if (create.data) return <ShowKey name={create.data.agent.name} secret={create.data.key} onDone={onDone} onCloseAutoFocus={onCloseAutoFocus} />;

  return (
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
          else setUnnamed(true);
        }}
      >
        <DialogHeader>
          <DialogTitle>New key</DialogTitle>
          <DialogDescription className="sr-only">Name the agent and choose which paths it may read or write.</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setUnnamed(false);
          }}
          placeholder="Agent name"
          aria-label="Agent name"
          aria-invalid={unnamed || undefined}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
        />
        <GrantsEditor value={grants} onChange={setGrants} />
        {(unnamed || create.error) && <p className="text-[13px] text-destructive">{unnamed ? "Name the agent" : create.error?.message}</p>}
        <DialogFooter>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Create key
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ShowKey({ name, secret, onDone, onCloseAutoFocus }: DialogProps & { name: string; secret: string }) {
  const [copied, setCopied] = useState(false);
  const [copiedOnce, setCopiedOnce] = useState(false);
  async function copy() {
    if (await copyText(secret)) {
      setCopied(true);
      setCopiedOnce(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    // The key can't be shown again: only Done closes it until it has been copied.
    <DialogContent
      showClose={copiedOnce}
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => !copiedOnce && e.preventDefault()}
      onCloseAutoFocus={onCloseAutoFocus}
    >
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

function EditGrants({ agent, onDone, onCloseAutoFocus }: DialogProps & { agent: Agent }) {
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
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
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

function Revoke({ agent, onDone, onCloseAutoFocus }: DialogProps & { agent: Agent }) {
  const refresh = useSaveAgents();
  const revoke = useMutation({
    mutationFn: () => api.updateAgent(agent.id, { revoked: true }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  return (
    <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
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
