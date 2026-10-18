"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster } from "sonner";

// Sonner 2 reads these custom properties; mapping them to our tokens replaces the old !important overrides.
const TOKENS = {
  "--normal-bg": "var(--color-surface)",
  "--normal-border": "var(--color-border)",
  "--normal-text": "var(--color-fg)",
  "--success-bg": "color-mix(in oklch, var(--color-success) 12%, var(--color-surface))",
  "--success-border": "color-mix(in oklch, var(--color-success) 40%, var(--color-border))",
  "--success-text": "var(--color-fg)",
  "--error-bg": "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))",
  "--error-border": "color-mix(in oklch, var(--color-danger) 40%, var(--color-border))",
  "--error-text": "var(--color-fg)",
  "--warning-bg": "color-mix(in oklch, var(--color-warning) 14%, var(--color-surface))",
  "--warning-border": "color-mix(in oklch, var(--color-warning) 45%, var(--color-border))",
  "--warning-text": "var(--color-fg)",
  "--info-bg": "color-mix(in oklch, var(--color-primary) 10%, var(--color-surface))",
  "--info-border": "color-mix(in oklch, var(--color-primary) 35%, var(--color-border))",
  "--info-text": "var(--color-fg)",
  "--border-radius": "var(--radius-lg)",
  zIndex: "var(--z-toast)",
} as React.CSSProperties;

/**
 * Sonner follows the in-app theme: an explicit light/dark choice wins; "system" defers to next-themes'
 * resolved value, and to sonner's own `system` (prefers-color-scheme) before hydration, so first paint
 * never guesses dark.
 */
export function ThemedToaster() {
  const { appearance } = useAppearance();
  const { resolvedTheme } = useTheme();
  const theme =
    appearance.theme !== "system" ? appearance.theme : resolvedTheme === "light" || resolvedTheme === "dark" ? resolvedTheme : "system";
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      richColors
      closeButton
      offset={16}
      mobileOffset={{ bottom: 88 }}
      style={TOKENS}
      toastOptions={{
        classNames: {
          toast: "shadow-[var(--shadow-md)] font-sans",
          description: "text-fg-muted",
          closeButton: "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        },
      }}
    />
  );
}
