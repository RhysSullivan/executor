"use client";

import dynamic from "next/dynamic";

const ControlPlanePageContent = dynamic(() => import("./page-content"), {
  ssr: false,
  loading: () => null,
});

const Page = () => <ControlPlanePageContent />;

export default Page;
