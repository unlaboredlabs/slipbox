import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorState, Placeholder } from "@/components/states";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <Outlet />
    </TooltipProvider>
  ),
  notFoundComponent: () => <Placeholder title="Nothing here" className="h-full" />,
  errorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} className="h-full" />,
});
