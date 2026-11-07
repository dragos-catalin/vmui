# Privacy policy — Vatra apps (Android, iOS, Windows)

> **DRAFT — for lawyer review, not legal advice.** Placeholders in `[brackets]` must be filled by
> the publisher before store launch. Version 0.1, 2026-11-07. Applies to `ro.vatra.app` (Android,
> Wear OS, Google TV), `ro.vatra.app` (iOS, watchOS) and `ro.vatra.desktop` (Windows).

---

## English

### 1. Who we are

The apps are published by **Dragos Catalin Vladulescu**, an individual developer in Romania
("we"). Contact: **privacy@dragoscatalin.ro** *(placeholder)*, postal address
**[P.O. box — owner to fill before store launch]**.

The apps are remote controls for **your own Vatra hub** — a computer in your home (Raspberry Pi
or virtual machine) that you or someone in your household runs. The hub, not the app, holds your
household's data, and the person who runs the hub (the "hub owner") decides what it stores.

### 2. Roles

| Data | Controller | Why |
| --- | --- | --- |
| Data on your hub (accounts, home state, journal, notifications) | The hub owner | They run the hub; we never receive it |
| Data in the app on your device | You | It stays on your device |
| Vatra Cloud push and relay metadata (only if the hub owner enables Vatra Cloud) | We | We run those services — see PRIVACY-CLOUD.md |
| Push delivery through Apple / Google | Apple / Google (independent controllers) and us for the request | Operating-system push services |

Most household use is personal or household activity (GDPR art. 2(2)(c)). *Lawyer: confirm the
hub owner's position when they invite non-family guests.*

### 3. What the app processes

| Category | What | Where it goes | Legal basis |
| --- | --- | --- | --- |
| Pairing | Hub address, device token issued by your hub, device name and platform | Your hub only; stored encrypted in the platform keystore | Contract (art. 6(1)(b)) — the service you asked for |
| Home control | Commands you tap, house state shown to you | Your hub only | Contract |
| Notifications | Push token (FCM / APNs / UnifiedPush endpoint), language | Your hub; Apple or Google to deliver; with Vatra Cloud, an opaque encrypted handle via our relay | Contract |
| Notification content | Card title/body (e.g. "Someone is at the door") | Through Vatra Cloud: end-to-end encrypted, only your device can read it. Direct FCM/APNs: as sent by your hub | Contract |
| Location (optional) | Only "home" / "away" when you arrive or leave; your position is computed on the device and never sent | Your hub | Consent (art. 6(1)(a)), revocable in OS settings |
| Camera (optional) | Scanning the pairing QR code; frames are not stored or sent | Nowhere | Consent (OS permission) |
| NFC (optional) | Reading/writing house-action stickers | Your hub when an action runs | Consent (OS permission) |
| Health data | **Not collected by the apps.** (Nutrition journal lives on the hub; see the hub's /privacy page) | — | — |

The apps contain **no advertising, no analytics SDK and no crash-reporting service**, and we do not
sell or share personal data. *Owner: re-check before each release that this is still true — store
data-safety forms depend on it.*

### 4. Third parties

- **Apple Push Notification service** (Apple Inc., USA) and **Firebase Cloud Messaging** (Google
  LLC, USA): deliver notifications. Transfers to the USA rely on the EU-US Data Privacy Framework
  (both certified) — *lawyer: confirm, and note pending appeal C-703/25 P*.
- **UnifiedPush distributor** of your choice (Android, optional).
- **Vatra Cloud** (us, Google Cloud europe-central2) — only if the hub owner enabled it.

### 5. Retention

The app keeps pairing data until you choose **Forget** (Android, iOS) or **Disconnect** (Windows),
or uninstall. Retention on the hub: see the hub's `/privacy`. Vatra Cloud: PRIVACY-CLOUD.md.

### 6. Your rights

Access, rectification, erasure, restriction, portability, objection and withdrawal of consent
(GDPR art. 15–22, art. 7(3)). For data on your hub, ask the hub owner or use `/account/delete` on
your hub. For Vatra Cloud data, email us; we answer within one month. You may complain to
**ANSPDCP** (www.dataprotection.ro) or your local authority.

### 7. Account deletion

There is no separate app account. How to delete your hub account and what is deleted:
`https://[your hub]/account/delete` and the public page linked from the store listing
**[public URL — owner to fill, e.g. https://vatra.dragoscatalin.ro/account/delete]**.

### 8. Children

The apps are not directed at children under 16. A hub owner may create a "child" profile for a
household member; the hub owner is responsible for it. *Lawyer: Romanian age of digital consent
(Law 190/2018 is silent → 16 by default); store age ratings.*

### 9. Security

Pairing tokens in the Android Keystore / iOS Keychain / Windows Credential Manager; TLS to the hub
(Vatra Cloud certificate or your own); per-device AES-256-GCM end-to-end key for push content.

### 10. Changes

We announce material changes in the app and in the release notes, with at least 30 days' notice
where the change needs your consent.

---

## Română

### 1. Cine suntem

Aplicațiile sunt publicate de **Dragos Catalin Vladulescu**, dezvoltator persoană fizică din
România („noi"). Contact: **privacy@dragoscatalin.ro** *(provizoriu)*, adresă poștală
**[P.O. box — owner to fill before store launch]**.

Aplicațiile sunt telecomenzi pentru **propriul tău hub Vatra** — un calculator din casa ta
(Raspberry Pi sau mașină virtuală) administrat de tine sau de cineva din gospodărie. Hubul, nu
aplicația, păstrează datele gospodăriei, iar persoana care îl administrează („proprietarul
hubului") decide ce se păstrează.

### 2. Roluri

| Date | Operator | De ce |
| --- | --- | --- |
| Datele de pe hub (conturi, starea casei, jurnal, notificări) | Proprietarul hubului | El administrează hubul; noi nu le primim |
| Datele din aplicație, pe dispozitivul tău | Tu | Rămân pe dispozitiv |
| Metadatele de notificare și releu Vatra Cloud (doar dacă proprietarul pornește Vatra Cloud) | Noi | Noi operăm serviciile — vezi PRIVACY-CLOUD.md |
| Livrarea notificărilor prin Apple / Google | Apple / Google (operatori independenți) și noi pentru cerere | Serviciile de notificare ale sistemului |

### 3. Ce prelucrează aplicația

| Categorie | Ce | Unde ajunge | Temei |
| --- | --- | --- | --- |
| Asociere | Adresa hubului, tokenul emis de hub, numele și platforma dispozitivului | Doar hubul tău; criptat în depozitul de chei al sistemului | Contract (art. 6(1)(b)) |
| Controlul casei | Comenzile date, starea casei afișată | Doar hubul tău | Contract |
| Notificări | Token de notificare (FCM / APNs / UnifiedPush), limbă | Hubul; Apple sau Google pentru livrare; cu Vatra Cloud, un identificator opac criptat prin releul nostru | Contract |
| Conținutul notificărilor | Titlu/text (ex. „Sună cineva la ușă") | Prin Vatra Cloud: criptat cap la cap, doar dispozitivul tău îl citește. FCM/APNs direct: cum îl trimite hubul | Contract |
| Locație (opțional) | Doar „acasă" / „plecat"; poziția se calculează pe dispozitiv și nu se trimite | Hubul tău | Consimțământ (art. 6(1)(a)), retras din setările sistemului |
| Cameră (opțional) | Scanarea codului QR de asociere; imaginile nu se salvează și nu se trimit | Nicăieri | Consimțământ (permisiune) |
| NFC (opțional) | Citirea/scrierea etichetelor cu acțiuni | Hubul, când rulează acțiunea | Consimțământ (permisiune) |
| Date de sănătate | **Aplicațiile nu le colectează.** (Jurnalul de nutriție e pe hub) | — | — |

Aplicațiile **nu conțin reclame, SDK de analiză sau serviciu de raportare a erorilor**, iar noi nu
vindem și nu partajăm date personale.

### 4. Terți

- **Apple Push Notification service** (Apple Inc., SUA) și **Firebase Cloud Messaging** (Google
  LLC, SUA): livrează notificările. Transferul în SUA se bazează pe EU-US Data Privacy Framework.
- **Distribuitorul UnifiedPush** ales de tine (Android, opțional).
- **Vatra Cloud** (noi, Google Cloud europe-central2) — doar dacă proprietarul hubului l-a pornit.

### 5. Păstrare

Aplicația păstrează datele de asociere până alegi **Uită** (Android, iOS) sau **Deconectează**
(Windows) ori o dezinstalezi. Pe hub: vezi `/privacy` al hubului. Vatra Cloud: PRIVACY-CLOUD.md.

### 6. Drepturile tale

Acces, rectificare, ștergere, restricționare, portabilitate, opoziție și retragerea
consimțământului (GDPR art. 15–22, art. 7(3)). Pentru datele de pe hub, întreabă proprietarul sau
folosește `/account/delete` pe hub. Pentru Vatra Cloud, scrie-ne; răspundem în cel mult o lună.
Poți depune plângere la **ANSPDCP** (www.dataprotection.ro).

### 7. Ștergerea contului

Nu există cont separat în aplicație. Cum îți ștergi contul de pe hub și ce se șterge:
`https://[hubul tău]/account/delete` și pagina publică din fișa magazinului
**[URL public — de completat de proprietar]**.

### 8. Copii

Aplicațiile nu se adresează copiilor sub 16 ani. Proprietarul hubului poate crea un profil de
„copil" pentru un membru al gospodăriei și răspunde de acesta.

### 9. Securitate

Tokenuri în Android Keystore / iOS Keychain / Windows Credential Manager; TLS spre hub; cheie
AES-256-GCM per dispozitiv pentru conținutul notificărilor.

### 10. Modificări

Anunțăm modificările importante în aplicație și în notele de versiune, cu cel puțin 30 de zile
înainte când e nevoie de acordul tău.
