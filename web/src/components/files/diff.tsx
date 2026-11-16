import { cn } from "@/lib/utils";

type Line = { kind: "add" | "del" | "ctx" | "gap"; text: string; old?: number; new?: number };

/** Parses a unified diff into rows with old and new line numbers. */
function parse(diff: string): Line[] {
  const lines: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "gap", text: "" });
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ |\\ No newline)/.test(raw) || !lines.length) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), new: newNo++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), old: oldNo++ });
    else if (raw.startsWith(" ") || raw === "") lines.push({ kind: "ctx", text: raw.slice(1), old: oldNo++, new: newNo++ });
  }
  // The split leaves an empty line after the final newline.
  while (lines.at(-1)?.kind === "ctx" && lines.at(-1)?.text === "" && diff.endsWith("\n")) lines.pop();
  // The first hunk marker needs no gap above it.
  if (lines[0]?.kind === "gap") lines.shift();
  return lines;
}

export function DiffView({ diff }: { diff: string }) {
  const lines = parse(diff);
  if (!lines.length) return <p className="text-[13px] text-muted-foreground">No changes in the text.</p>;
  return (
    <div className="overflow-x-auto rounded-lg bg-muted/40 py-2 font-mono text-[12.5px] leading-[1.65]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) =>
            line.kind === "gap" ? (
              <tr key={i}>
                <td colSpan={4} className="py-1.5 pl-4 text-muted-foreground/50 select-none">⋯</td>
              </tr>
            ) : (
              <tr key={i} className={cn(line.kind === "add" && "bg-added", line.kind === "del" && "bg-removed")}>
                <td className="w-10 pr-2 pl-4 text-right align-top text-muted-foreground/50 select-none">{line.old ?? ""}</td>
                <td className="w-10 pr-2 text-right align-top text-muted-foreground/50 select-none">{line.new ?? ""}</td>
                <td
                  className={cn(
                    "w-5 text-center align-top select-none",
                    line.kind === "add" ? "text-added-strong" : line.kind === "del" ? "text-removed-strong" : "text-transparent",
                  )}
                >
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                </td>
                <td className="pr-4 whitespace-pre-wrap break-words">{line.text || " "}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
