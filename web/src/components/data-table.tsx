import { flexRender, type RowData, type Table } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Fixed width in pixels; columns without one share the rest. */
    width?: number;
  }
}

/** A quiet table: muted header, no rule lines, rounded hover on whole rows. */
export function DataTable<T>({ table, rowClassName }: { table: Table<T>; rowClassName?: (row: T) => string | undefined }) {
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th
                key={header.id}
                className="h-8 px-3 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
                style={{ width: header.column.columnDef.meta?.width }}
              >
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className={cn("group", rowClassName?.(row.original))}>
            {row.getVisibleCells().map((cell) => (
              <td
                key={cell.id}
                className="h-9 overflow-hidden px-3 align-middle text-ellipsis whitespace-nowrap transition-colors group-hover:bg-accent/70 first:rounded-l-md last:rounded-r-md"
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 pt-3">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${92 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}
