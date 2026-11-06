/** Hub ↔ app contract version. Bump API_VERSION on any additive change to the
 *  app routes; bump MIN_CLIENT when a change breaks older apps (they then show
 *  "update the app" instead of failing on a renamed field). */
export const API_VERSION = 1;
export const MIN_CLIENT = 1;
