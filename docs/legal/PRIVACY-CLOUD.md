# Privacy notice — Vatra Cloud

> **DRAFT — for lawyer review, not legal advice.** Version 0.1, 2026-11-07. Technical source of
> truth: [docs/product/cloud/CONTRACT.md](../product/cloud/CONTRACT.md). Change this file when the
> contract changes.

---

## English

### 1. Controller

**Dragos Catalin Vladulescu**, individual developer, Romania. Contact
**privacy@dragoscatalin.ro** *(placeholder)*, **[P.O. box — owner to fill before store launch]**.
No DPO is appointed (no large-scale monitoring or special-category processing — *lawyer: confirm,
art. 37*).

### 2. What Vatra Cloud is

Optional services a hub owner can switch on. They are **off by default**; a hub without them
works fully on the home network.

| Service | Purpose | What we see | What we never see |
| --- | --- | --- | --- |
| **SNI relay** (`relay.<domain>`, e2-micro VM, europe-central2) | Reach your hub from outside the home | Hub id, client IP address, connection times and byte counts, the requested host name (SNI) | Content: TLS is end to end; the certificate key stays on the hub |
| **Push relay** (`push.<domain>`, Cloud Run) | Deliver notifications to the apps via Apple / Google | Push handle (encrypts the platform token, which we decrypt only to send), hub id, card id, kind (e.g. `intercom`), priority, timing; requester IP for handle registration | Card content: AES-256-GCM end-to-end encrypted per device |
| **ACME DNS proxy** (`acme.<domain>`, Cloud Run) | Obtain a Let's Encrypt certificate for `<hubId>.<domain>` | Hub id, one-time challenge value, timing | Certificate private key |
| **Relay token issuer** | 24-hour credential for the relay | Hub id, timing | — |
| **Demo hub** | Store reviewers try the app | Reviewer account activity on a fake house, wiped nightly | Real household data |

The hub id is derived from the hub's public key; it identifies a hub, not a person. Combined with
an IP address it can relate to a household, so we treat it as personal data.

### 3. Legal basis

- Running the services the hub owner switched on: **contract** (art. 6(1)(b)).
- Abuse prevention, rate limits, kill switch, security logs: **legitimate interest** (art. 6(1)(f))
  in keeping the service available and safe. *Lawyer: balancing test.*

### 4. Recipients and processors

| Recipient | Role | Location | Transfer mechanism |
| --- | --- | --- | --- |
| Google Cloud (Cloud Run, Compute Engine, Secret Manager) | Processor (hosting) | EU (europe-central2, Warsaw) | Google Cloud DPA; EU region |
| Apple (APNs) | Independent controller for delivery | USA | EU-US DPF |
| Google (FCM) | Independent controller for delivery | USA | EU-US DPF |
| Let's Encrypt (ISRG) | Independent CA | USA | Certificate Transparency makes `<hubId>.<domain>` public by design |
| Brivio DNS (operated by the publisher) | DNS for `<domain>` | EU | Same controller |

*Lawyer: whether Apple/Google are processors or independent controllers for push; DPA wording.*

### 5. Retention

| Data | Retention |
| --- | --- |
| Push handles | Not stored by us; the hub stores them. Decrypted in memory per send |
| Rate-limit counters, replay cache (JWT ids) | In memory, ≤ 24 h / 10 min |
| Relay connection state | In memory while connected |
| Service logs (Cloud Run / VM: request time, path, status, IP) | 30 days *(owner: set log bucket retention to match)* |
| DNS challenge TXT records | Deleted after validation (cleanup call), at most a few minutes |
| Certificate Transparency entries | Permanent and public (outside our control) |

### 6. Your rights

As in GDPR art. 15–22. Because we do not hold names or emails, include your **hub id** (shown in
the hub under Settings › Vatra Cloud) when you write. Turning Vatra Cloud off on the hub stops all
processing; we then hold only logs until they expire. Complaints: **ANSPDCP**.

### 7. Security

Hubs authenticate with short-lived Ed25519 JWTs (≤ 5 min, replay-protected); relay hubs pin the
relay key; per-hub limits and a kill switch; secrets in Google Secret Manager.

### 8. Price

Vatra Cloud is free during the beta. A paid plan, if introduced, will be sold on the web and will
come with separate terms (see TERMS-CLOUD-DRAFT.md).

---

## Română

### 1. Operator

**Dragos Catalin Vladulescu**, dezvoltator persoană fizică, România. Contact
**privacy@dragoscatalin.ro** *(provizoriu)*, **[P.O. box — owner to fill before store launch]**.

### 2. Ce este Vatra Cloud

Servicii opționale pe care proprietarul unui hub le poate porni. Sunt **oprite implicit**; un hub
fără ele funcționează complet în rețeaua de acasă.

| Serviciu | Scop | Ce vedem | Ce nu vedem niciodată |
| --- | --- | --- | --- |
| **Releu SNI** | Acces la hub din afara casei | Id-ul hubului, IP-ul clientului, momentele și volumul conexiunilor, numele de gazdă (SNI) | Conținutul: TLS cap la cap, cheia certificatului rămâne pe hub |
| **Releu de notificări** | Livrarea notificărilor prin Apple / Google | Identificatorul de notificare (criptează tokenul platformei, decriptat doar la trimitere), id hub, id card, tip, prioritate, moment; IP-ul la înregistrarea identificatorului | Conținutul cardului: criptat AES-256-GCM cap la cap |
| **Proxy DNS ACME** | Certificat Let's Encrypt pentru `<hubId>.<domain>` | Id hub, valoarea de verificare de unică folosință, moment | Cheia privată a certificatului |
| **Emitentul de tokenuri pentru releu** | Credențială de 24 h | Id hub, moment | — |
| **Hubul demo** | Testare de către recenzorii magazinelor | Activitatea contului de test pe o casă fictivă, ștearsă zilnic | Date reale |

### 3. Temei juridic

- Serviciile pornite de proprietarul hubului: **contract** (art. 6(1)(b)).
- Prevenirea abuzurilor, limite, oprire de urgență, jurnale de securitate: **interes legitim**
  (art. 6(1)(f)).

### 4. Destinatari

Google Cloud (persoană împuternicită, UE — europe-central2), Apple APNs și Google FCM (operatori
independenți, SUA, EU-US DPF), Let's Encrypt (registrele Certificate Transparency sunt publice),
Brivio DNS (același operator).

### 5. Păstrare

Identificatorii de notificare nu sunt stocați de noi; contoarele de limitare stau în memorie
≤ 24 h; jurnalele serviciilor 30 de zile; înregistrările DNS de verificare se șterg după validare;
intrările Certificate Transparency sunt permanente și publice.

### 6. Drepturile tale

Conform GDPR art. 15–22. Pentru că nu deținem nume sau e-mailuri, include **id-ul hubului**
(Setări › Vatra Cloud pe hub). Oprirea Vatra Cloud pe hub oprește orice prelucrare. Plângeri:
**ANSPDCP**.

### 7. Securitate

JWT Ed25519 de scurtă durată, cheia releului fixată pe hub, limite per hub, secrete în Google
Secret Manager.

### 8. Preț

Vatra Cloud este gratuit în perioada beta. Un plan plătit, dacă va exista, va fi vândut pe web cu
termeni separați.
