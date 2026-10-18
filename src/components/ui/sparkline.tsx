"use client";

import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useId } from "react";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Tiny inline SVG sparkline. Values come from the server already sorted oldest -> newest.
 * The draw-in animation is skipped automatically under reduced motion (MotionConfig in the provider).
 */
export function Sparkline({ values, width = 96, height = 24, className, ariaLabel }: SparklineProps) {
  const gradId = useId();
  const t = useTranslations("common");
  if (values.length === 0) {
    return (
      <span className={`inline-block text-2xs text-fg-muted ${className ?? ""}`} title={t("noData")}>
        <span aria-hidden>—</span>
        <span className="sr-only">{t("noData")}</span>
      </span>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return [x, y] as const;
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${(pts.at(-1)?.[0] ?? 0).toFixed(1)},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? t("trend")}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <m.path
        d={areaPath}
        fill={`url(#${gradId})`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.36, ease: "easeOut" }}
      />
      <m.path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}
