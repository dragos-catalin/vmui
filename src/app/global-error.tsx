"use client";

// Replaces the root layout when it throws, so no i18n provider is mounted:
// bilingual inline copy (EN + RO), tokens read straight from globals.css.
import { VatraMark } from "@/components/brand/vatra-mark";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Vatra</title>
      </head>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">
        <main role="alert" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-5 px-4 text-center">
          <VatraMark size={56} state="error" className="text-fg-soft" />
          <div className="space-y-3">
            <div className="space-y-1">
              <h1 className="text-balance text-xl font-semibold tracking-tight">Something went wrong</h1>
              <p className="text-pretty text-sm text-fg-muted">Vatra could not render this screen. Try again, or go back home.</p>
            </div>
            <div lang="ro" className="space-y-1">
              <p className="text-balance text-base font-semibold tracking-tight">Ceva n-a mers</p>
              <p className="text-pretty text-sm text-fg-muted">Vatra nu a putut afișa acest ecran. Încearcă din nou sau întoarce-te acasă.</p>
            </div>
            {error.digest ? <p className="font-mono text-xs text-fg-muted">Error id / Cod eroare: {error.digest}</p> : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] bg-primary px-4 text-sm font-medium text-primary-fg hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Retry · Reîncearcă
            </button>
            <a
              href="/"
              className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] border border-border bg-surface px-4 text-sm font-medium hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Home · Acasă
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
