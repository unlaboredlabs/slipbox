import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivityIcon, FileTextIcon, KeyRoundIcon, LogOutIcon, SearchIcon, type LucideIcon } from "lucide-react";
import { api, token } from "@/lib/api";
import { APP_NAME } from "@/lib/config";

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

const rowClass =
  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0";

function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  function signOut() {
    token.clear();
    queryClient.clear();
    navigate({ to: "/login" });
  }

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 bg-sidebar px-3 pt-4 pb-3">
        <span className="mb-4 px-2.5 text-[15px] font-semibold tracking-[-0.03em]">{APP_NAME}</span>
        {pages.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={rowClass}
            activeProps={{ className: "bg-accent font-medium !text-foreground" }}
          >
            <Icon strokeWidth={1.75} />
            {label}
          </Link>
        ))}
        <div className="mt-auto flex items-center">
          <button type="button" onClick={signOut} className={`${rowClass} flex-1`}>
            <LogOutIcon strokeWidth={1.75} />
            Sign out
          </button>
          <Version />
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

function Version() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), staleTime: 60_000 });
  const version = health.data?.version;
  if (!version) return null;
  return <span className="px-2.5 text-[11px] text-muted-foreground/70 tabular-nums">{/^\d/.test(version) ? `v${version}` : version}</span>;
}
