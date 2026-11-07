/** Hub ↔ app contract version. Bump API_VERSION on any additive change to the
 *  app routes; bump MIN_CLIENT when a change breaks older apps (they then show
 *  "update the app" instead of failing on a renamed field). */
// 2: GET/PUT /api/v1/app/push (FCM client options, UnifiedPush endpoints, P7-03), POST /api/v1/app/presence (P7-05)
export const API_VERSION = 2;
export const MIN_CLIENT = 1;
