import { redirect } from "next/navigation";
import { RouteSectionView } from "@/components/route-section-view";
import { getCapabilitySnapshot } from "@/lib/capability-probes";

export default async function CalendarRoutePage() {
  const { capabilities } = await getCapabilitySnapshot();

  if (!capabilities.calendarWorkspace) {
    redirect("/dashboard");
  }

  return <RouteSectionView section="calendar" />;
}
