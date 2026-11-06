import "server-only";

import { household } from "@/lib/household";

// Texts the hub renders with no viewer attached (activity feed on the ESP OLED and
// Turzx screen, HA friendly names of the entities vmui publishes). They follow the
// household language. `deviceText` is ASCII only (the OLED font has no diacritics);
// `screenText` is for the Turzx screen and HA, which render full Unicode.

type CopilotEvent = "ask" | "done" | "blocked" | "failed";

const T = {
  en: {
    autoOpenOn: (m: number) => `intercom: auto-open ${m} min`,
    autoOpenOff: "intercom: auto-open off",
    ringing: "intercom: ringing",
    ringingAutoOpen: "intercom: ringing, opening",
    doorOpened: (by: string) => `intercom: door opened (${by})`,
    haRinging: "Intercom ringing",
    haAutoOpen: "Intercom auto-open",
    copilot: { ask: "Copilot waiting", done: "Copilot done", blocked: "Command blocked", failed: "Failed" } satisfies Record<CopilotEvent, string>,
    meal: (name: string, kcal: number) => `Meal: ${name} - ${kcal} kcal`,
    water: (ml: number, glasses: number, total: string) => `water +${ml} ml (${glasses} glasses, ${total})`,
  },
  ro: {
    autoOpenOn: (m: number) => `interfon: deschidere automata ${m} min`,
    autoOpenOff: "interfon: deschidere automata oprita",
    ringing: "interfon: suna",
    ringingAutoOpen: "interfon: suna, deschid automat",
    doorOpened: (by: string) => `interfon: usa deschisa (${by})`,
    haRinging: "Interfon suna",
    haAutoOpen: "Interfon deschidere automata",
    copilot: { ask: "Copilot asteapta", done: "Copilot gata", blocked: "Comanda blocata", failed: "A esuat" } satisfies Record<CopilotEvent, string>,
    meal: (name: string, kcal: number) => `Masa: ${name} - ${kcal} kcal`,
    water: (ml: number, glasses: number, total: string) => `apa +${ml} ml (${glasses} pahare, ${total})`,
  },
} as const;

export const deviceText = () => T[household().locale];

const S = {
  en: {
    nutritionApp: "Nutrition",
    mealSaved: (name: string) => `${name} saved`,
    mealType: { breakfast: "breakfast", lunch: "lunch", dinner: "dinner", snack: "snack" } as Record<string, string>,
    remaining: (kcal: number) => `${kcal} kcal left`,
    waterAdded: (amount: string) => `+${amount} water`,
    waterTotal: (total: string, target: string, reached: boolean) => `${total} of ${target}${reached ? " · target reached" : ""}`,
    haNutrition: (id: string) => `Nutrition ${id}`,
    moon: ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"],
  },
  ro: {
    nutritionApp: "Nutriție",
    mealSaved: (name: string) => `${name} salvată`,
    mealType: { breakfast: "mic dejun", lunch: "prânz", dinner: "cină", snack: "gustare" } as Record<string, string>,
    remaining: (kcal: number) => `rămas ${kcal} kcal`,
    waterAdded: (amount: string) => `+${amount} apă`,
    waterTotal: (total: string, target: string, reached: boolean) => `${total} din ${target}${reached ? " · țintă atinsă" : ""}`,
    haNutrition: (id: string) => `Nutriție ${id}`,
    moon: ["Lună nouă", "Semilună în creștere", "Primul pătrar", "Lună în creștere", "Lună plină", "Lună în descreștere", "Ultimul pătrar", "Semilună în descreștere"],
  },
} as const;

export const screenText = () => S[household().locale];
