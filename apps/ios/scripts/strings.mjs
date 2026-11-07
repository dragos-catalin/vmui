// Builds apps/ios/Shared/Localizable.xcstrings (en + ro) from the Android app strings (one translation
// source for both phones) plus the iOS-only keys below. Android %1$s / %1$d become %1$@ / %1$lld.
//   node apps/ios/scripts/strings.mjs          write
//   node apps/ios/scripts/strings.mjs --check  exit 1 when stale or when a Swift L("key") has no en+ro text
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const android = join(root, "apps", "android", "app", "src", "main", "res");

function xml(file) {
  const out = {};
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/<string name="([a-z0-9_]+)"[^>]*>([\s\S]*?)<\/string>/g)) {
    out[m[1]] = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return out;
}

const en = xml(join(android, "values", "strings.xml"));
const ro = xml(join(android, "values-ro", "strings.xml"));
ro.app_name ??= en.app_name;

// Keys only the Apple apps use. [en, ro]
const IOS = {
  ok: ["OK", "OK"],
  loading: ["Loading", "Se încarcă"],
  brightness: ["Brightness", "Luminozitate"],
  ambilight_music: ["Music lights", "Lumini de muzică"],
  push_apns: ["Notifications from this home", "Notificări de la această casă"],
  push_body: [
    "The hub wakes this iPhone through Apple Push, with its own key or through the Vatra push relay. Turn off to get updates only while the app is open.",
    "Hubul trezește acest iPhone prin Apple Push, cu cheia lui sau prin releul Vatra. Oprește ca să primești noutăți doar cu aplicația deschisă.",
  ],
  push_failed: ["This iPhone could not register for notifications. Check Settings › Notifications › Vatra.", "Acest iPhone nu s-a putut înregistra pentru notificări. Verifică Configurări › Notificări › Vatra."],
  presence_denied: ["Location is off for Vatra. Allow it \"Always\" in Settings to notice when you arrive.", "Locația e oprită pentru Vatra. Permite-o „Întotdeauna” în Configurări ca să observe când ajungi."],
  widget_description: ["Lights on and water today, with quick buttons.", "Lumini aprinse și apa de azi, cu butoane rapide."],
  watch_name: ["Apple Watch", "Apple Watch"],
  pair_title: ["Join a home", "Intră într-o casă"],
  watch_pair_body: ["Pair with the iPhone that is already in this home, or ask the hub for approval.", "Asociază-te cu iPhone-ul care e deja în această casă sau cere aprobare hubului."],
  watch_pair_phone: ["Use my iPhone", "Folosește iPhone-ul meu"],
  watch_phone_unreachable: ["Open Vatra on your iPhone, keep it nearby, and try again.", "Deschide Vatra pe iPhone, ține-l aproape și încearcă din nou."],
  "intent.not_paired": ["Open Vatra and join a home first.", "Deschide Vatra și intră mai întâi într-o casă."],
  "intent.offline": ["Can't reach the hub.", "Hubul nu răspunde."],
  "intent.toggle.title": ["Switch a device", "Comută un dispozitiv"],
  "intent.toggle.description": ["Turns one device in your home on or off.", "Pornește sau oprește un dispozitiv din casă."],
  "intent.toggle.on": ["On", "Pornit"],
  "intent.action.title": ["House action", "Acțiune în casă"],
  "intent.action.description": ["Runs a house action: movie lights, lights off, wake the PC, a glass of water.", "Rulează o acțiune: lumini de film, stinge luminile, pornește PC-ul, un pahar de apă."],
  "intent.scene.title": ["Light scene", "Scenă de lumini"],
  "intent.scene.description": ["Applies one of your home's light scenes.", "Aplică una dintre scenele de lumini ale casei."],
  "intent.door.title": ["Open the door", "Deschide ușa"],
  "intent.door.description": ["Opens the door for the ring on your Lock Screen.", "Deschide ușa pentru soneria de pe ecranul blocat."],
  "intent.door.card": ["Ring", "Sonerie"],
  account_title: ["Your account", "Contul tău"],
  account_delete: ["Delete my account", "Șterge-mi contul"],
  account_delete_owner: ["The owner deletes the household by resetting the hub.", "Proprietarul șterge casa resetând hubul."],
  account_delete_warning: [
    "This deletes your account in %1$s: your sign-in, your paired phones and watches, your room access, your meals, water and nutrition profile, and your notifications. The house, its devices and the other members stay. This cannot be undone.",
    "Asta îți șterge contul din %1$s: datele de conectare, telefoanele și ceasurile asociate, accesul la camere, mesele, apa și profilul de nutriție, și notificările tale. Casa, dispozitivele și ceilalți membri rămân. Nu se poate anula.",
  ],
  account_delete_password: ["Your password", "Parola ta"],
  account_delete_confirm: ["Delete account permanently", "Șterge contul definitiv"],
  account_delete_failed: ["The account could not be deleted. Try again.", "Contul nu a putut fi șters. Încearcă din nou."],
  account_delete_page: ["Account deletion", "Ștergerea contului"],
  privacy_policy: ["Privacy policy", "Politica de confidențialitate"],
  "entity.device": ["Device", "Dispozitiv"],
  "entity.house_action": ["Action", "Acțiune"],
  "entity.scene": ["Scene", "Scenă"],
  // Generic alert of a Vatra Cloud relay push (aps.alert loc keys, CONTRACT.md "Push relay"); the NSE
  // replaces it with the decrypted card. One title per hub notify kind (src/lib/notify NOTIFY_KINDS).
  VATRA_PUSH_BODY: ["Open to see details", "Deschide pentru detalii"],
  VATRA_PUSH_TITLE_GENERIC: ["Vatra", "Vatra"],
  VATRA_PUSH_TITLE_INTERCOM: ["Someone is at the door", "Sună cineva la ușă"],
  VATRA_PUSH_TITLE_DOOR: ["A door opened", "S-a deschis o ușă"],
  VATRA_PUSH_TITLE_WINDOW: ["A window is open", "O fereastră e deschisă"],
  VATRA_PUSH_TITLE_PRESENCE: ["Movement at home", "Mișcare în casă"],
  VATRA_PUSH_TITLE_BATTERY: ["Battery low", "Baterie descărcată"],
  VATRA_PUSH_TITLE_WATER: ["Time for water", "E timpul pentru apă"],
  VATRA_PUSH_TITLE_NUTRITION: ["Nutrition", "Nutriție"],
  VATRA_PUSH_TITLE_PC: ["PC update", "Noutate de la PC"],
  VATRA_PUSH_TITLE_PI: ["Hub update", "Noutate de la hub"],
  VATRA_PUSH_TITLE_PAIRING: ["A device wants to join", "Un dispozitiv vrea să intre"],
  VATRA_PUSH_TITLE_COPILOT: ["Copilot", "Copilot"],
  VATRA_PUSH_TITLE_AGENTS: ["Agents", "Agenți"],
  VATRA_PUSH_TITLE_AMBILIGHT: ["Ambilight", "Ambilight"],
  VATRA_PUSH_TITLE_ALERT: ["Alert from home", "Alertă de acasă"],
  VATRA_PUSH_TITLE_HOME: ["News from home", "Noutăți de acasă"],
  VATRA_PUSH_TITLE_CONTACT: ["New message", "Mesaj nou"],
  VATRA_PUSH_TITLE_SYSTEM: ["Vatra", "Vatra"],
  VATRA_PUSH_TITLE_CARD: ["Vatra", "Vatra"],
};

const fmt = (s) => s.replace(/%(\d+)\$s/g, "%$1$@").replace(/%(\d+)\$d/g, "%$1$lld");

const strings = {};
const all = new Set([...Object.keys(en), ...Object.keys(IOS)]);
for (const k of [...all].sort()) {
  const e = IOS[k]?.[0] ?? en[k];
  const r = IOS[k]?.[1] ?? ro[k];
  if (e == null || r == null) continue;
  strings[k] = {
    extractionState: "manual",
    localizations: {
      en: { stringUnit: { state: "translated", value: fmt(e) } },
      ro: { stringUnit: { state: "translated", value: fmt(r) } },
    },
  };
}
const out = `${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2)}\n`;
const file = join(root, "apps", "ios", "Shared", "Localizable.xcstrings");

function swiftKeys(dir, acc = new Set()) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== "build" && n !== ".build") swiftKeys(p, acc);
    } else if (n.endsWith(".swift")) {
      const t = readFileSync(p, "utf8");
      for (const m of t.matchAll(/\bL\("([a-z0-9_.]+)"/g)) acc.add(m[1]);
      for (const m of t.matchAll(/(?:LocalizedStringResource|TypeDisplayRepresentation|IntentDescription)\(?\s*=?\s*"([a-z0-9_.]+)"/g)) acc.add(m[1]);
      for (const m of t.matchAll(/(?:title|shortTitle): "([a-z0-9_.]+)"/g)) acc.add(m[1]);
      for (const m of t.matchAll(/\.[a-zA-Z]+: "([a-z0-9_.]+)"/g)) acc.add(m[1]);
    }
  }
  return acc;
}

if (process.argv.includes("--check")) {
  let bad = false;
  let cur = "";
  try {
    cur = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {}
  if (cur !== out) {
    console.error(`stale (run node apps/ios/scripts/strings.mjs): ${file}`);
    bad = true;
  }
  const missing = [...swiftKeys(join(root, "apps", "ios"))].filter((k) => !strings[k]);
  if (missing.length) {
    console.error(`Swift keys without en+ro text: ${missing.join(", ")}`);
    bad = true;
  }
  if (bad) process.exit(1);
  console.log(`ios strings up to date (${Object.keys(strings).length} keys, en + ro)`);
} else {
  writeFileSync(file, out);
  console.log(`wrote ${file} (${Object.keys(strings).length} keys)`);
}
