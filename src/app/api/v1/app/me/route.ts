import { meRoute } from "@/lib/api/app-routes";
import { handle } from "@/lib/api/define-route";

export const dynamic = "force-dynamic";

export const GET = handle(meRoute);
