import { Suspense } from "react";
import { OrganizationSettingsView } from "@/components/organization-settings-view";

export default function OrganizationPage() {
  return (
    <Suspense>
      <OrganizationSettingsView />
    </Suspense>
  );
}
