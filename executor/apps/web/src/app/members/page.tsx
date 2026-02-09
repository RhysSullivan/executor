import { redirect } from "next/navigation";

export default function MembersPage() {
  redirect("/organization?tab=members");
}
