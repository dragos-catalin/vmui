"use client";

import { EmptyState } from "@/components/ui";
import { Archive, FileArchive } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";

export interface ArchiveFile {
  name: string;
  size: number;
  mtime: number;
}

export function ArchiveList({ files }: { files: ArchiveFile[] }) {
  const t = useTranslations("observe.archive");
  const format = useFormatter();
  if (files.length === 0) {
    return <EmptyState illustration="activity" compact icon={<Archive />} title={t("empty.title")} description={t("empty.description")} />;
  }
  return (
    <ul className="divide-y divide-border">
      {files.map((f, i) => (
        <m.li
          key={f.name}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
          className="flex flex-wrap items-center gap-3 py-2.5"
        >
          <FileArchive className="size-4 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm">{f.name}</div>
            <time dateTime={new Date(f.mtime).toISOString()} className="text-xs text-fg-muted">
              {format.dateTime(new Date(f.mtime), { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-fg-muted">
            {format.number(f.size / 1024, { maximumFractionDigits: 1 })} KB
          </span>
        </m.li>
      ))}
    </ul>
  );
}
