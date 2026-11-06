import { intercomGetRoute, intercomActRoute } from "@/lib/api/app-routes";
import { handle } from "@/lib/api/define-route";

export const dynamic = "force-dynamic";

export const GET = handle(intercomGetRoute);
export const POST = handle(intercomActRoute);
