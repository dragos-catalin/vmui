"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExportButtonsProps {
  filename: string;
  rows: Array<Record<string, unknown>>;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(","));
  }
  return lines.join("\n");
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ filename, rows }: ExportButtonsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => download(new Blob([toCsv(rows)], { type: "text/csv" }), `${filename}.csv`)}
      >
        <Download className="size-4" aria-hidden /> CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          download(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), `${filename}.json`)
        }
      >
        <Download className="size-4" aria-hidden /> JSON
      </Button>
    </div>
  );
}
