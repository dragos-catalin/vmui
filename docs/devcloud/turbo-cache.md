# Turborepo remote cache (devcloud DC-031/032)

Self-hosted `ducktors/turborepo-remote-cache` 2.14.3 runs on Cloud Run in `dragos-devcloud` / `europe-central2`, with artifacts stored natively in GCS.

| | |
|---|---|
| URL | `https://turbo-cache-oouyuce4fq-lm.a.run.app` (service `turbo-cache`) |
| Team | `dragos` (any string works; it namespaces artifacts in the bucket) |
| Token | Secret Manager `devcloud-turbo-token` (48 chars, never printed) |
| Bucket | `gs://dragos-devcloud-turbo-cache`. Lifecycle: delete when customTime > 30 d or age > 45 d |
| Scaling | 0–4 instances, 2 vCPU / 2 GiB, HTTP/2 end-to-end (`HTTP2=true`), CPU boost |
| Provision / verify | `pwsh -NoProfile -File infra/devcloud/turbo-cache.ps1 [-Verify]` |

## Use it

Set these in the terminal that runs turbo, or in a CI job:

```powershell
$env:TURBO_API   = 'https://turbo-cache-oouyuce4fq-lm.a.run.app'
$env:TURBO_TEAM  = 'dragos'
$env:TURBO_TOKEN = (gcloud secrets versions access latest --secret devcloud-turbo-token --project dragos-devcloud).Trim()
```

- **Wire the same three variables everywhere.** Local machine, cloud workspaces and CI runners must use the same values, otherwise they do not share artifacts.
- **Failures fall back to the local cache.** If the remote is down, turbo logs a warning and uses the local cache only.
- **Do not re-enable Vercel's cache.** brivio's `scripts/pre-push.mjs` explains why that injection was removed: Vercel's cache answered 402. This one is ours.

## Notes

- **Missing `team` returns 400.** The server rejects any request without `?team=`. Turbo always sends it; the probe has to send it too.
- **Missing token returns 400, not 401.** A request without a token gets "Missing Authorization header".
- **PowerShell interpolation trap.** In `"$url/v8/artifacts/$h?team=x"`, PowerShell reads `$h?team` as one variable name and the query string disappears. Write `${h}?` instead.
