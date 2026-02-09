"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CreditCard, Users } from "lucide-react";
import { BillingView } from "@/components/billing-view";
import { MembersView } from "@/components/members-view";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type OrganizationTab = "members" | "billing";

function normalizeTab(value: string | null): OrganizationTab {
  return value === "billing" ? "billing" : "members";
}

export function OrganizationSettingsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tab = useMemo(() => normalizeTab(searchParams.get("tab")), [searchParams]);

  const setTab = (nextTab: string) => {
    const normalizedTab = normalizeTab(nextTab);
    const nextSearch = new URLSearchParams(searchParams.toString());
    nextSearch.set("tab", normalizedTab);
    router.replace(`${pathname}?${nextSearch.toString()}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization Settings"
        description="Manage organization-level members, invites, and billing"
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="members">
            <Users className="h-4 w-4" />
            Members
          </TabsTrigger>
          <TabsTrigger value="billing">
            <CreditCard className="h-4 w-4" />
            Billing
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <MembersView showHeader={false} />
        </TabsContent>
        <TabsContent value="billing">
          <BillingView showHeader={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
