import { pushConfigRoute, pushRegisterRoute } from "@/lib/api/app-routes";
import { handle } from "@/lib/api/define-route";

export const dynamic = "force-dynamic";

export const GET = handle(pushConfigRoute);
export const PUT = handle(pushRegisterRoute);
