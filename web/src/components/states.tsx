import type { LucideIcon } from "lucide-react";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A quiet centred message for empty and error states. */
export function Placeholder({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center", className)}>
      {Icon && <Icon className="size-5 text-muted-foreground/60" strokeWidth={1.75} />}
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <Placeholder icon={TriangleAlertIcon} title={message} className={className}>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon className="size-3.5" />
          Retry
        </Button>
      )}
    </Placeholder>
  );
}

export function PageHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 px-6 pt-1">
      <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </header>
  );
}
