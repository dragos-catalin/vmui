# Cloud browser tests (dragos-devcloud)

Browser tests never run on the workstation. `run.mjs` packs the working tree (tracked + untracked, minus `.gitignore`, through a throwaway git index), uploads it to `gs://vmui-e2e-runs-dragos-devcloud/runs/<id>/`, and boots a spot VM `vmui-e2e-<id>` from image family `vmui-e2e-runner`. The VM installs, runs `next build`, starts `next start` on 127.0.0.1:3737 with a fresh SQLite DB and a random master key, seeds an admin session (`seed.cjs`), runs the tests, uploads the results, and deletes itself. `--max-run-duration=2h` deletes it if the script never finishes.

## One-off setup

```powershell
pwsh -NoProfile -File scripts/e2e-cloud/provision.ps1   # bucket, SA, self-delete role (idempotent)
pwsh -NoProfile -File scripts/e2e-cloud/bake-image.ps1  # image family vmui-e2e-runner (~10 min)
```

Bake the image again after a Playwright bump or a big lockfile change. A stale image still works; the run just installs what is missing.

## Run

```powershell
node scripts/e2e-cloud/run.mjs tests/e2e/smoke.spec.ts                 # playwright test <args>
node scripts/e2e-cloud/run.mjs --cmd "pnpm exec playwright test tests/e2e/ui-audit.spec.ts; node tests/e2e/lighthouse.mjs; node tests/e2e/bundles.mjs" --fetch test-results
node scripts/e2e-cloud/run.mjs --attach <id>                           # follow a run again
node scripts/e2e-cloud/run.mjs --ledger                                # cost history
```

Flags: `--cmd`, `--fetch dir[,dir]`, `--machine` (default `n2d-standard-8`), `--zone` (default `europe-central2-a`), `--keep`, `--no-wait`, `--attach`, `--ledger`. Anything else is passed through to `playwright test`.

Results land in `.copilot-tmp/e2e-cloud/<id>/`: `playwright-report/`, `test-results/`, the fetched dirs, and `vm.log`. The process exit code is the VM command's exit code. The `--cmd` exit code is the exit code of the LAST command in the chain.

On the VM, specs get `PW_BASE_URL` and `PW_SESSION_FILE` (the session id for the `vmui_session` cookie). Audit knobs: `UI_AUDIT_WIDTHS`, `UI_AUDIT_ROUTES` (a regex), `UI_AUDIT_LOCALES`, `UI_AUDIT_THEMES`, `UI_AUDIT_AXE_WIDTHS`, `UI_AUDIT_STRICT=1`, plus `LH_ROUTES` and `LH_PRESETS` for Lighthouse.
