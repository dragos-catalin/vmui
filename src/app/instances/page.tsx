import { permanentRedirect } from "next/navigation";

// The instance list is the dashboard at "/"; /instances/[id] and /instances/new live under this segment.
export default function InstancesIndexPage(): never {
  permanentRedirect("/");
}
