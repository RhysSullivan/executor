import { createFileRoute } from "@tanstack/react-router";
import { MenubarMvpView } from "@/components/menubar/mvp-view";

export const Route = createFileRoute("/menubar")({
  component: MenubarPage,
});

function MenubarPage() {
  return <MenubarMvpView />;
}
