import type ambilight from "../../messages/ambilight/en.json";
import type appearance from "../../messages/appearance/en.json";
import type auth from "../../messages/auth/en.json";
import type dashboard from "../../messages/dashboard/en.json";
import type devices from "../../messages/devices/en.json";
import type en from "../../messages/en.json";
import type family from "../../messages/family/en.json";
import type homeCards from "../../messages/homeCards/en.json";
import type misc from "../../messages/misc/en.json";
import type nestHub from "../../messages/nestHub/en.json";
import type notify from "../../messages/notify/en.json";
import type nutrition from "../../messages/nutrition/en.json";
import type settings from "../../messages/settings/en.json";
import type shell from "../../messages/shell/en.json";
import type turzx from "../../messages/turzx/en.json";
import type vm from "../../messages/vm/en.json";
import type extras from "../../messages/extras/en.json";
import type govern from "../../messages/govern/en.json";
import type observe from "../../messages/observe/en.json";
import type ops from "../../messages/ops/en.json";
import type cloud from "../../messages/cloud/en.json";
import type setup from "../../messages/setup/en.json";
import type { LOCALES } from "./config";

declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof LOCALES)[number];
    Messages: typeof en & {
      homeCards: typeof homeCards;
      notify: typeof notify;
      nutrition: typeof nutrition;
      ambilight: typeof ambilight;
      turzx: typeof turzx;
      nestHub: typeof nestHub;
      devices: typeof devices;
      family: typeof family;
      shell: typeof shell;
      appearance: typeof appearance;
      vm: typeof vm;
      extras: typeof extras;
      govern: typeof govern;
      observe: typeof observe;
      ops: typeof ops;
      cloud: typeof cloud;
      dashboard: typeof dashboard;
      settings: typeof settings;
      auth: typeof auth;
      misc: typeof misc;
      setup: typeof setup;
    };
  }
}
