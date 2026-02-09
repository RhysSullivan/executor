import { redirect } from "next/navigation";

export default function BillingPage() {
  redirect("/organization?tab=billing");
}
