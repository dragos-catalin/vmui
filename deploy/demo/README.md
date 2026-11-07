# Vatra demo hub (`vatra-demo`, Cloud Run)

Store reviewers get a working hub without a house: the normal hub image with `VATRA_DEMO=1`
(contract: `docs/product/cloud/CONTRACT.md`, section "Demo hub"; tracker P10-04).

## What the demo mode does

- **Simulated Home Assistant** in-process (`src/lib/demo/sim-ha.ts`): 4 rooms (living room, kitchen,
  bedroom, hallway), lights (2 RGB), an AC, the front door lock, an intercom doorbell, temperature and
  humidity sensors, a weather entity with forecast, persons, a calendar, a shopping list and every
  script the hub calls. No `HA_URL`. Service calls change state and stream `state_changed`.
- **Fresh seeded SQLite in `/tmp/vatra`** at every cold start (`bootDemo()` in `src/lib/demo/reset.ts`
  wipes the db + key first, then seeds), and at 03:00 UTC (the process exits; Cloud Run starts a new
  container with an empty `/tmp`).
- **Reviewer** `review@vatra.dragoscatalin.ro`, owner of the house, no 2FA (enrolling 2FA is refused),
  password from secret `vatra-demo-review-password`.
- **Static pairing invite** `VATRA_DEMO_INVITE` (16–64 url-safe chars, secret `vatra-demo-invite`):
  `vatra://pair?h=<demo host>&c=<invite>` in the store review notes. Redeemable any number of times,
  pairs as the reviewer, never consumed.
- **Refused with 403 / `demo_readonly`**: backup restore, master key rotation, integration secret
  writes, family and member management, invite acceptance, user creation / deletion / role change,
  password change and reset, 2FA enrolment, firmware adoption, API key and appliance token minting.
  Vatra Cloud enrolment must call `demoReadonly()` / `demoRefusal()` from `src/lib/demo/mode.ts`
  in `src/lib/cloud` (owned by that workstream).

## Secrets (once)

```powershell
$p = 'dragos-devcloud'   # or the product project
# 24+ random chars each; generate locally, never paste them into a terminal that is logged
gcloud secrets create vatra-demo-review-password --project $p --replication-policy automatic --data-file <file>
gcloud secrets create vatra-demo-invite --project $p --replication-policy automatic --data-file <file>
# the Cloud Run runtime service account needs roles/secretmanager.secretAccessor on both
```

## Deploy

Build the image from a clean tree (commit, push, then `deploy-clean.ps1`), push it to Artifact
Registry, then:

```powershell
$img = '<region>-docker.pkg.dev/<project>/vatra/hub@sha256:<digest>'
(Get-Content deploy/demo/cloudrun.yaml -Raw).Replace('${IMAGE}', $img) | Set-Content .copilot-tmp/vatra-demo.yaml -NoNewline
gcloud run services replace .copilot-tmp/vatra-demo.yaml --project <project> --region europe-central2
gcloud run services add-iam-policy-binding vatra-demo --member allUsers --role roles/run.invoker --project <project> --region europe-central2
```

`maxScale: 1` is deliberate: the demo state (SQLite, simulated house, sessions) lives in one process.

## Verify (live)

```powershell
$env:BASE = 'https://vatra-demo-<hash>.run.app'
$env:VATRA_DEMO_REVIEW_PASSWORD = (gcloud secrets versions access latest --secret vatra-demo-review-password --project <project>)
$env:VATRA_DEMO_INVITE = (gcloud secrets versions access latest --secret vatra-demo-invite --project <project>)
node deploy/demo/smoke.mjs
```

The script prints PASS/FAIL per check and never prints a secret: `/api/discover` claimed, reviewer
sign-in, the static invite pairing twice, `/api/v1/app/state` with the paired device's token, and
`/api/backup/restore` answering `403 demo_readonly`.
