# Lawyer checklist — Vatra (P11-01)

> **DRAFT — for lawyer review, not legal advice.** Prepared 2026-11-07 for a Romanian/EU lawyer.
> Documents in this folder: PRIVACY-APPS.md, PRIVACY-CLOUD.md, TERMS-CLOUD-DRAFT.md,
> DSA-CONTACT.md, AI-DISCLOSURE.md; hub pages `/privacy`, `/legal`, `/licenses`,
> `/account/delete`; repo `SECURITY.md`, `public/.well-known/security.txt`, `LICENSE` (AGPL-3.0),
> `NOTICE.md`.

## Context in one paragraph

Vatra is a self-hosted smart-home hub (Raspberry Pi / VM, AGPL-3.0) with native apps (Android,
iOS, Windows) published by an individual (Dragos Catalin Vladulescu, Romania) under personal
developer accounts. Household data stays on the user's hub. Optional "Vatra Cloud" (free beta,
Google Cloud EU) relays encrypted traffic, end-to-end-encrypted push and ACME DNS challenges. The
hub can open the front door (intercom), control heating and run a local AI assistant; a nutrition
coach can call the publisher's codai AI gateway.

## Open questions

| # | Topic | Question | Where it matters |
| --- | --- | --- | --- |
| L1 | **Cloud ToS** | Review TERMS-CLOUD-DRAFT.md end to end: liability caps for an individual publisher, missed safety notifications (door, smoke), suspension/appeal wording, governing law and consumer forum, beta-to-paid transition. | TERMS-CLOUD-DRAFT.md §3, §6–§10 |
| L2 | **CRA product class** | Under the Cyber Resilience Act (Reg. 2024/2847), is a hub that controls door locks / intercoms and smart-home devices a *default*, *important class I* (Annex III, e.g. "smart home general purpose virtual assistants", "smart home products with security functionalities, including smart door locks…") or *class II* product? Does free AGPL software published by an individual without monetisation fall under the open-source steward / non-commercial exclusion — and does that change once Vatra Cloud is paid? Conformity route and timeline (reporting from 11 Sep 2026, full from 11 Dec 2027). | SECURITY.md (vulnerability handling), release process |
| L3 | **AI Act art. 50(2)** | Publisher is a deployer of third-party models (Ollama local, codai gateway). Must hub-generated text (chat answers, coach notification) carry machine-readable marking, or does the upstream provider's marking suffice? Effect of the AI Omnibus grace period (2 Dec 2026). Is the art. 50(1) notice as implemented sufficient? | AI-DISCLOSURE.md; `src/components/ai/ai-consent.tsx` |
| L4 | **DSA trader / classification** | Is the publisher a "trader" (individual, free apps, later paid cloud)? Confirm mere-conduit classification of the relay/push services and the micro-enterprise exemption (art. 19). Is a phone number needed on `/legal`? | DSA-CONTACT.md, `/legal` |
| L5 | **Romanian consumer law** | Free app + later paid web subscription: OUG 34/2014 (information, 14-day withdrawal, art. 11¹ withdrawal button), OUG 141/2021 (digital content conformity, including for "free" content paid with data), Law 363/2007, ANPC/SAL information, price-change notice. Do the apps need consumer information while free? | TERMS-CLOUD-DRAFT.md §3, §10; future checkout |
| L6 | **Export of data** | Is the encrypted whole-hub backup (owner only) a sufficient portability mechanism (art. 20) for members, or must each member get a self-service export (e.g. nutrition journal CSV)? Data Act Ch. VI switching: applicable to Vatra Cloud given it holds no customer data? | `/privacy` "Export and delete" |
| L7 | **Children** | Child profiles created by the hub owner: household exemption (art. 2(2)(c)) vs. publisher duties; digital age of consent in Romania (default 16); store age ratings and Apple Kids / Google Families policies; nutrition journal for minors. | PRIVACY-APPS.md §8 |
| L8 | Roles | Hub owner as controller vs. publisher; is the household exemption lost when the owner invites guests or runs it for a small office? Does the publisher become a processor for anything hub-side (it does not receive data)? | PRIVACY-APPS.md §2, `/privacy` |
| L9 | Transfers | APNs/FCM: processors or independent controllers? Reliance on EU-US DPF given pending appeal C-703/25 P; SCC fallback text. | PRIVACY-APPS.md §4, PRIVACY-CLOUD.md §4 |
| L10 | Legitimate interest | Balancing test for abuse-prevention logs (IP, hub id, 30 days). | PRIVACY-CLOUD.md §3, §5 |
| L11 | Account deletion | Owner cannot self-delete (must reset the hub / transfer ownership). Acceptable for Google Play and Apple 5.1.1(v)? Apps have no in-app delete button yet — they link to the hub; is "open your hub in a browser" enough for Play's in-app path? | `/account/delete`, `src/lib/account/delete.ts` |
| L12 | Audit log after deletion | We keep "account deleted" + user id for 30 days live, then an archive on the hub (indefinite). Lawful under art. 17(3)? Should the archive be pruned? | `src/lib/audit-retention.ts` |
| L13 | Safe harbour | Enforceability of SECURITY.md safe-harbour language in Romania (Criminal Code art. 360–365 on illegal access). | SECURITY.md |
| L14 | Licences | Confirm the NOTICE allow-list additions **OFL-1.1** (Inter fonts), **MIT-0** (nodemailer), **Zlib** (pako, `MIT AND Zlib`), and that **MPL-2.0** files (noVNC, web-push) shipped unmodified meet MPL notice duties; `node-forge` taken under BSD-3-Clause from `BSD-3-Clause OR GPL-2.0`; `caniuse-lite` CC-BY-4.0 attribution via NOTICE.md. AGPL-3.0 §13 "source to network users" satisfied by `/licenses` + `VATRA_SOURCE_URL` once the repository is public? | `src/lib/legal/notice-core.ts`, `/licenses` |
| L15 | codai as processor | The publisher's own codai gateway processes coach facts: DPA / retention / no-training statement needed? | AI-DISCLOSURE.md |
| L16 | ePrivacy | Hub sets only strictly necessary cookies (session, locale, appearance, sidebar state). Confirm no consent banner needed (Law 506/2004 art. 4(5)). | Hub |

## Placeholders the owner must fill before store launch

| Placeholder | Where | How to set |
| --- | --- | --- |
| `privacy@dragoscatalin.ro` (confirm mailbox exists) | all docs, `/privacy`, `/legal`, `/account/delete` | `VATRA_PRIVACY_EMAIL` env on the hub image; edit docs |
| `security@dragoscatalin.ro` (confirm mailbox exists) | SECURITY.md, security.txt, `/legal` | `VATRA_SECURITY_EMAIL`; edit `public/.well-known/security.txt` |
| `[P.O. box — owner to fill before store launch]` (postal address) | all docs, `/legal` | `VATRA_PUBLISHER_POSTAL` |
| Phone (same placeholder) | `/legal`, DSA-CONTACT.md | `VATRA_PUBLISHER_PHONE` |
| Source URL `https://github.com/dragoscatalin/vatra` (repo is private today) | `/licenses`, security.txt `Policy` | `VATRA_SOURCE_URL` |
| Commit shown on `/licenses` | `/licenses` | `VATRA_COMMIT` at image build (release workflow) |
| security.txt `Canonical` `https://vatra.dragoscatalin.ro/.well-known/security.txt` | security.txt | Publish the file at that URL, or change it to the product domain |
| Public account-deletion URL for store listings | PRIVACY-APPS.md §7 | e.g. the demo hub's `/account/delete` or the product site |
| Log bucket retention 30 days | PRIVACY-CLOUD.md §5 | Cloud Logging retention on `dragos-devcloud` |
| security.txt `Expires: 2027-11-07` | security.txt | Renew yearly |
