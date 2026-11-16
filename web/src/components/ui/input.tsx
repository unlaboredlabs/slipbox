import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-[13px] transition-[color,box-shadow] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
