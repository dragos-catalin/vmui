import { waterGetRoute, waterActRoute } from "@/lib/api/app-routes";
import { handle } from "@/lib/api/define-route";

export const dynamic = "force-dynamic";

export const GET = handle(waterGetRoute);
export const POST = handle(waterActRoute);
