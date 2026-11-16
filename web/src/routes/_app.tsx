import { useEffect } from "react";
import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivityIcon, FileTextIcon, KeyRoundIcon, LogOutIcon, SearchIcon, type LucideIcon } from "lucide-react";
import { api, token } from "@/lib/api";
import { APP_NAME } from "@/lib/config";
import { followLive, useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (!token.get()) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: AppShell,
});

const pages: { to: "/files" | "/activity" | "/agents" | "/search"; label: string; icon: LucideIcon }[] = [
  { to: "/files", label: "Files", icon: FileTextIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/agents", label: "Agents", icon: KeyRoundIcon },
  { to: "/search", label: "Search", icon: SearchIcon },
];

// Below md the nav shows only icons.
const rowClass =
  "flex h-8 items-center gap-2.5 rounded-md px-2.5 max-md:justify-center max-md:px-0 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0";

function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  function signOut() {
    token.clear();
    queryClient.clear();
    navigate({ to: "/login" });
  }

  useEffect(() => followLive(queryClient), [queryClient]);

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 bg-sidebar px-3 pt-4 pb-3 max-md:w-14 max-md:px-2">
        <span className="mb-4 h-5 px-2.5 text-[15px] font-semibold tracking-[-0.03em] max-md:sr-only">{APP_NAME}</span>
        {pages.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            title={label}
            className={rowClass}
            activeProps={{ className: "bg-accent font-medium !text-foreground" }}
          >
            <Icon strokeWidth={1.75} />
            <span className="max-md:sr-only">{label}</span>
          </Link>
        ))}
        <div className="mt-auto flex items-center max-md:flex-col-reverse max-md:items-stretch max-md:gap-2">
          <button type="button" onClick={signOut} title="Sign out" className={cn(rowClass, "flex-1")}>
            <LogOutIcon strokeWidth={1.75} />
            <span className="max-md:sr-only">Sign out</span>
          </button>
          <Status />
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

/** The version, or "Offline" while the server can't be reached (what the pages show may be stale). */
function Status() {
  const live = useLive();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), staleTime: 60_000 });
  const version = health.data?.version;
  if (live === false) {
    return (
      <span title="Can't reach the server; what you see may be out of date" className="flex items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground max-md:justify-center max-md:px-0">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
        <span className="max-md:sr-only">Offline</span>
      </span>
    );
  }
  if (!version) return null;
  return <span className="px-2.5 text-[11px] text-muted-foreground tabular-nums max-md:px-0 max-md:text-center">{/^\d/.test(version) ? `v${version}` : version}</span>;
}
