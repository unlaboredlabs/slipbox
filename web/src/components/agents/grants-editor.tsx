import { PlusIcon, XIcon } from "lucide-react";
import type { Grant } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type GrantDraft = Grant & { key: number };

let nextKey = 0;
export const draftGrants = (grants: Grant[]): GrantDraft[] => grants.map((g) => ({ ...g, key: nextKey++ }));
export const newGrant = (): GrantDraft => ({ prefix: "", mode: "read", key: nextKey++ });

/** The grants to send: trimmed, empty rows dropped, one entry per prefix (write wins). */
export function cleanGrants(drafts: GrantDraft[]): Grant[] {
  const byPrefix = new Map<string, Grant["mode"]>();
  for (const { prefix, mode } of drafts) {
    const p = prefix.trim();
    if (p) byPrefix.set(p, byPrefix.get(p) === "write" ? "write" : mode);
  }
  return [...byPrefix].map(([prefix, mode]) => ({ prefix, mode }));
}

export function GrantsEditor({ value, onChange }: { value: GrantDraft[]; onChange: (next: GrantDraft[]) => void }) {
  const update = (key: number, patch: Partial<Grant>) => onChange(value.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  return (
    <div className="flex flex-col gap-2">
      {value.map((grant, i) => (
        <div key={grant.key} className="flex items-center gap-2">
          <Input
            value={grant.prefix}
            onChange={(e) => update(grant.key, { prefix: e.target.value })}
            placeholder="projects/shop/"
            aria-label="Path prefix"
            autoFocus={i === value.length - 1 && grant.prefix === "" && value.length > 1}
            className="font-mono text-[12.5px]"
            spellCheck={false}
            autoCapitalize="off"
          />
          <ModeToggle value={grant.mode} onChange={(mode) => update(grant.key, { mode })} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove prefix"
            onClick={() => onChange(value.filter((g) => g.key !== grant.key))}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start px-2" onClick={() => onChange([...value, newGrant()])}>
        <PlusIcon className="size-3.5" />
        Add prefix
      </Button>
    </div>
  );
}

function ModeToggle({ value, onChange }: { value: Grant["mode"]; onChange: (mode: Grant["mode"]) => void }) {
  return (
    <div role="radiogroup" aria-label="Access" className="flex h-8 shrink-0 items-center rounded-md bg-muted p-0.5">
      {(["read", "write"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            "h-full rounded-[5px] px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
            value === mode && "bg-background font-medium text-foreground shadow-xs dark:bg-accent",
          )}
        >
          {mode === "read" ? "Read" : "Write"}
        </button>
      ))}
    </div>
  );
}
