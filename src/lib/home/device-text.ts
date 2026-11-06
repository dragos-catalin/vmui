import "server-only";

import { household } from "@/lib/household";

// Texts the hub renders with no viewer attached (activity feed on the ESP OLED and
// Turzx screen, HA friendly names of the entities vmui publishes). They follow the
// household language. ASCII only: the OLED font has no diacritics.

const T = {
  en: {
    autoOpenOn: (m: number) => `intercom: auto-open ${m} min`,
    autoOpenOff: "intercom: auto-open off",
    ringing: "intercom: ringing",
    ringingAutoOpen: "intercom: ringing, opening",
    doorOpened: (by: string) => `intercom: door opened (${by})`,
    haRinging: "Intercom ringing",
    haAutoOpen: "Intercom auto-open",
  },
  ro: {
    autoOpenOn: (m: number) => `interfon: deschidere automata ${m} min`,
    autoOpenOff: "interfon: deschidere automata oprita",
    ringing: "interfon: suna",
    ringingAutoOpen: "interfon: suna, deschid automat",
    doorOpened: (by: string) => `interfon: usa deschisa (${by})`,
    haRinging: "Interfon suna",
    haAutoOpen: "Interfon deschidere automata",
  },
} as const;

export const deviceText = () => T[household().locale];
