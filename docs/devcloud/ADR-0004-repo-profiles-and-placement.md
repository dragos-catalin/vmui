# ADR-0004 (devcloud): a profile per repository, and placement that reads it

Status: accepted by the owner in chat on 2026-11-25, implemented in slices.

## Context

- **Placement is a hand-written table.** agentq learns where work goes from two
  tables in its own config: `cloudWorkspaces` (repository to one workspace) and
  `cloudRegistry` (workspace to project and zone). One VM per workspace, one job
  at a time, and the file knows nothing about what a lane needs - a lane that
  needs a JDK and a lane that needs a Go compiler look identical to it.

- **The images live here and can rot unnoticed.** `infra/devcloud/images` bakes
  one family per toolchain (`devcloud-ci-<toolchain>`) and rebakes weekly.
  Measured on 2026-11-25 with `images.ps1 -List`: seven toolchains declared,
  most families rebaked on 2026-11-21, but `rust-tauri-win` was last built on
  2026-10-13 and `win-desktop` on 2026-10-16. Two families served jobs for six
  weeks without anyone knowing they had stopped being rebaked, because nothing
  consumes the list and therefore nothing can complain about it.

- **A declaration has a reader, or it drifts.** The same failure appeared on the
  same day in the job runner: `runner-agent.mjs` resolves a step on stream close
  rather than process exit, so a long-lived descendant that inherits the job's
  stdio keeps the job open forever. A Gradle build did exactly that: the lane
  printed its verdict at 63 s, the job never reported an exit code, and the
  instance had to be reset twice to free it. The lesson generalises - a rule
  nobody checks is not a rule.

- **The owner's directive (2026-11-25):** agentq should organise and operate the
  devcloud itself - reuse the machines already up, start others when needed,
  know what each repository's operations require, keep one source of truth for
  the images and the SDK, and run many jobs at once wherever a machine is not
  saturated. Some repositories need dedicated instances; others can share.

## Decision

1. **A repository declares what its operations need** in `.devcloud/profile.json`
   (schema v1, this directory). It names lanes, toolchains, a machine class, a
   concurrency and a timeout. It never names a VM, a zone or a project: those are
   placement results, and a lane must be able to land on a machine that did not
   exist when the profile was written.

2. **The schema, the validator and the toolchain list live here**, in
   `infra/devcloud/profile`. One source of truth. A profile that asks for a
   family nobody bakes is a red validator on the workstation, not a surprise on a
   VM that cannot build.

3. **agentq consumes it.** For a job whose repository has a profile, agentq
   resolves the lane to toolchains, then to a machine. When this repository is not
   checked out on the machine doing the placing, agentq falls back to the tables
   it has today - the profile is an upgrade, not a new dependency.

4. **Placement order:** a running workspace whose image family covers the lane's
   toolchains and whose free capacity covers its `concurrency`; else a suspended
   workspace with the right family (resume); else a new instance from the family;
   else a place in the queue behind the lane's own concurrency limit.
   `dedicated: true` means the workspace is not shared with another repository
   even while idle.

5. **A claim about interference needs its reason.** `dedicated: true`, or
   `concurrency: 1`, requires a `why`. It is the one field a later reader cannot
   re-derive from the numbers, and it is the field that stops a copy-paste lane
   from becoming a permanent, unexamined bottleneck.

6. **The build is driven by the profiles.** `images.ps1 -FromProfiles E:\gh`
   bakes every toolchain the active repositories ask for and reports families
   older than the rebake window. The six-week rot above is why this is part of
   the decision and not a chore somebody remembers.

## Consequences

- **A lane's needs are reviewable next to the lane.** Adding a lane without
  saying what it needs is now visible in review rather than discovered by a
  failed job.
- **Sharing becomes deliberate.** A lane declaring `concurrency: 2` may run
  beside another repository's fast lane on the same VM; the performance-budget
  lane may not, and its reason is written down. Measured evidence for why that
  matters: the same gate member ran 21.3 s idle and 129.9 s under load, so a
  budget sharing a machine with a heavy job reports the machine, not the code.
- **"Which families must exist" becomes answerable**, by
  `validate.mjs --root E:\gh`, instead of being folklore.
- **agentq gains a dependency on this repository's checkout path.** The fallback
  in point 3 is what keeps a machine without it working.
- **A lane is now described in two places.** The mitigation is that the profile
  describes needs and cannot drift into being a copy of the lane's steps.

## Not decided here

- **Parallel jobs inside one agent.** The runner is single-threaded today: it
  claims one job, runs it, and only then looks at the queue. `concurrency` is
  declared and validated now so a runner can honour it later; until then it is
  read as "how many machines of this lane may run at once".
- **A cancellation channel.** There is none. A job that wedges has to be killed
  by its own timeout or by resetting the instance, which is what "communicate
  fast and cheap" will have to fix before concurrency is raised.
- **A live progress channel.** The job log is published to `jobs/<id>/log` and
  is flushed only when a child process writes something, so a job whose children
  write to a file looks identical to a hung job. Measured 2026-11-25: three
  minutes of an empty log with the build running normally.

## Alternatives considered

- **A copy of the schema in every repository.** Rejected: a schema in five
  places is five schemas, and the validator would be the sixth.
- **Profiles in agentq's config, as `cloudWorkspaces` is today.** Rejected: the
  repository that owns a lane is the only place that knows when the lane
  changes, and a central file edited by hand on one machine is exactly how the
  two rotted image families went unnoticed.
- **Naming the VM in the profile.** Rejected: it would make every profile an
  inventory of the fleet, and it would break the moment a machine is reinstalled.
- **Deriving the needs from the repository's files** (a `Cargo.toml` implies
  Rust). Rejected as the primary source: it can infer a toolchain but not a
  concurrency, a timeout, or whether a lane may share a machine with another
  repository's work. It is a reasonable consistency check later.