import { redirect } from "next/navigation";
import { RouteSectionView } from "@/components/route-section-view";
import { getCapabilitySnapshot } from "@/lib/capability-probes";

export default async function Page() {
  const { capabilities } = await getCapabilitySnapshot();

  if (!capabilities.tailscaleNetworking) {
    redirect("/dashboard");
  }

  return <RouteSectionView section="tailscale" />;
}
