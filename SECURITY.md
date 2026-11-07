# Security policy

> DRAFT — for lawyer review, not legal advice. The safe-harbour wording in particular needs review.
> `security@dragoscatalin.ro` is a placeholder the publisher may change; keep it in sync with
> `public/.well-known/security.txt` and `VATRA_SECURITY_EMAIL`.

Vatra is a self-hosted smart-home hub that can open doors, control heating and run commands on
machines. We take reports seriously and thank everyone who reports responsibly.

## Supported versions

| Component | Supported |
| --- | --- |
| Hub (this repository), latest stable release | Yes |
| Hub, previous minor release | Security fixes for 90 days after the next minor ships |
| Hub, beta channel | Best effort |
| Older releases | No — update via the built-in updater |
| ESP32 firmware (`firmware/`) | Latest release |
| Android, iOS and Windows apps | Latest store version |
| Vatra Cloud services (relay, push, ACME proxy) | Always (we run them) |

## Reporting a vulnerability

- Email **security@dragoscatalin.ro** (placeholder). English or Romanian.
- Or use GitHub private vulnerability reporting on the repository, once it is public.
- Please include: affected component and version, steps to reproduce, impact, and whether it is
  already public. Do not include other people's personal data.
- Do not open a public issue for a vulnerability.

We aim to acknowledge within **3 working days**, give a first assessment within **10 working
days**, and keep you updated at least every two weeks.

## Disclosure

We follow coordinated disclosure with a **90-day** deadline from the report. We may agree a
shorter window when a fix ships earlier, or a longer one when a fix needs a firmware or app-store
release; we will tell you why. Once fixed we publish an advisory and credit you unless you prefer
otherwise. Where EU law requires it (Cyber Resilience Act reporting of actively exploited
vulnerabilities, from 11 September 2026), we also notify the competent authorities.

## Safe harbour

If you act in good faith under this policy, we will not pursue or support legal action against
you for your research, and we consider it authorised. Good faith means you:

- test only your own hub, devices and accounts, or the public demo hub;
- do not access, change or delete other people's data, and stop as soon as you reach any;
- do not degrade Vatra Cloud for others (no denial of service, spam or social engineering);
- do not open physical locks or doors you do not own;
- give us reasonable time to fix before disclosure.

This does not bind third parties (Apple, Google, Home Assistant, cloud providers) and cannot waive
criminal law.

## Out of scope

- Findings that need physical access to an unlocked hub or a rooted phone.
- Missing hardening headers without a concrete exploit.
- Vulnerabilities in Home Assistant, ESPHome or other upstream projects: report them upstream
  (we are happy to help coordinate).
