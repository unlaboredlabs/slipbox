import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, LoaderIcon } from "lucide-react";
import { ApiError, api, token } from "@/lib/api";
import { APP_NAME } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: ({ search }) => {
    if (token.get()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: Login,
});

/** Only follow redirects within the dashboard. */
function safeRedirect(target?: string) {
  return target?.startsWith("/") && !target.startsWith("//") && !target.startsWith("/login") ? target : "/files";
}

function Login() {
  const navigate = useNavigate();
  const { redirect: target } = Route.useSearch();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const candidate = value.trim();
    if (!candidate) return setError("Enter the admin token");
    setPending(true);
    setError(null);
    try {
      await api.health(candidate);
      token.set(candidate);
      navigate({ href: safeRedirect(target), replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That token isn't right" : (err as Error).message);
      setPending(false);
    }
  }

  return (
    <main className="flex h-full items-center justify-center px-6 pb-[12vh]">
      <form onSubmit={submit} className="flex w-full max-w-[300px] flex-col gap-6">
        <span className="text-center text-xl font-semibold tracking-[-0.03em]">{APP_NAME}</span>
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Admin token"
              aria-label="Admin token"
              aria-invalid={error ? true : undefined}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              className="h-10 rounded-lg pr-11 text-sm"
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={pending}
              aria-label="Sign in"
              className="absolute top-1.5 right-1.5 rounded-md"
            >
              {pending ? <LoaderIcon className="size-3.5 animate-spin" /> : <ArrowRightIcon className="size-3.5" />}
            </Button>
          </div>
          <p className="h-4 text-center text-xs text-destructive" role="alert">
            {error}
          </p>
        </div>
      </form>
    </main>
  );
}
