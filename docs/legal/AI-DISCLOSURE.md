# AI disclosure

> **DRAFT — for lawyer review, not legal advice.** Version 0.1, 2026-11-07. In-product text:
> `messages/legal/{en,ro}.json` › `ai`; consent logic: `src/lib/ai/consent.ts`.

---

## English

### What uses AI on a Vatra hub

| Feature | Model / route | Data sent | When |
| --- | --- | --- | --- |
| **AI assistant** (`/ai`) | An Ollama model server: `VMUI_OLLAMA_URL` (default `http://127.0.0.1:11434`, i.e. the same machine), model `VMUI_OLLAMA_MODEL` (default `llama3.2`) | Your message, the conversation so far (≤ 20 turns), and results of the tools the assistant calls: VM inventory (name, provider, region, state, type), the last 50 audit-log entries (actions, targets, messages — may include member emails), cost estimates, optimiser recommendations | Only after **you** accept the notice; per user |
| **Nutrition coach** | codai gateway `https://ai.codai.ro/v1/chat/completions`, model `codai-fast` | Coach kind, journal totals (calories, protein, meals, streak), household language. No names, no meal descriptions | Only when the owner added a `CODAI_API_KEY` **and** the owner accepted the AI notice; at most once a day |
| **MCP tools** (`/api/mcp`) | None on the hub — external agents (e.g. codai phone/desktop) call the hub's tools with an operator API key | Tool results go to whatever agent holds the key | Owner-created API keys, scoped |

If the owner points `VMUI_OLLAMA_URL` at a remote server, the assistant's data goes there; the
consent notice shows the configured host.

### Obligations addressed

- **AI Act art. 50(1)** (from 2 Aug 2026): users are told they interact with an AI system — consent
  panel before first use, persistent "AI-generated" label under each answer and in the chat header.
- **Art. 50(2)** (machine-readable marking of synthetic text, grace to 2 Dec 2026 for systems on the
  market ⚠): the publisher is a *deployer* of third-party models, not their provider; chat answers
  are shown in the hub UI only, not published. ⚖ Whether a hub that generates notification text
  must mark it; whether the upstream (codai / Ollama model) marking suffices.
- **Art. 4** AI literacy: the notice says answers can be wrong; the publisher is a single
  individual.
- **Art. 5**: no prohibited practice (no manipulation, scoring, emotion recognition).
- **GDPR**: consent per user (art. 6(1)(a), 7) recorded with version and timestamp in
  `app_settings` key `ai_consent:<userId>`; revocable with one click; the server refuses calls
  without it (`askAgentAction` → `ai_consent_required`; coach falls back to canned text).

### Provider terms

codai gateway: the publisher's own service; ⚖ confirm its retention (prompts not used for
training) and list it as a processor in its own DPA. Ollama: local software (MIT), no data leaves
unless configured.

---

## Română

### Ce folosește AI pe un hub Vatra

| Funcție | Model / traseu | Date trimise | Când |
| --- | --- | --- | --- |
| **Asistent AI** (`/ai`) | Server de modele Ollama: `VMUI_OLLAMA_URL` (implicit pe același calculator), model `VMUI_OLLAMA_MODEL` | Mesajul, conversația (≤ 20 de replici) și rezultatele uneltelor: inventar VM, ultimele 50 de intrări din jurnal (pot conține e-mailuri), costuri, recomandări | Doar după ce **tu** accepți notificarea; per utilizator |
| **Antrenor de nutriție** | Gateway codai `https://ai.codai.ro`, model `codai-fast` | Tipul sfatului, totaluri din jurnal (calorii, proteine, mese, serie), limba. Fără nume, fără descrierea meselor | Doar cu `CODAI_API_KEY` **și** acordul proprietarului; cel mult o dată pe zi |
| **Unelte MCP** (`/api/mcp`) | Niciun model pe hub — agenți externi apelează uneltele cu o cheie API | Rezultatele merg la agentul care deține cheia | Chei create de proprietar, cu permisiuni limitate |

### Obligații acoperite

- **AI Act art. 50(1)**: utilizatorul este informat că interacționează cu un sistem AI — notificare
  înainte de prima folosire, eticheta „Generat de AI" sub fiecare răspuns.
- **Art. 50(2)**: editorul este *implementator*, nu furnizor al modelelor; răspunsurile apar doar în
  interfața hubului. ⚖ De confirmat de avocat.
- **GDPR**: consimțământ per utilizator, cu versiune și moment, retras cu un clic; serverul refuză
  apelurile fără el.
