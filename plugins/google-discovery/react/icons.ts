import type { Source } from "@executor/react";

const GOOGLE_DISCOVERY_SERVICE_ICONS: Record<string, string> = {
  admin: "https://ssl.gstatic.com/images/branding/product/2x/admin_2020q4_48dp.png",
  bigquery: "https://ssl.gstatic.com/bqui1/favicon.ico",
  calendar: "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png",
  chat: "https://ssl.gstatic.com/chat/favicon/favicon_v2.ico",
  classroom: "https://ssl.gstatic.com/classroom/favicon.png",
  cloudresourcemanager: "https://www.gstatic.com/devrel-devsite/prod/v0e0f589edd85502a40d78d7d0825db8ea5ef3b99b1571571945f0f3f764ff61b/cloud/images/favicons/onecloud/favicon.ico",
  docs: "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico",
  drive: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  forms: "https://ssl.gstatic.com/docs/forms/device_home/android_192.png",
  gmail: "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
  keep: "https://ssl.gstatic.com/keep/icon_2020q4v2_128.png",
  people: "https://ssl.gstatic.com/images/branding/product/2x/contacts_2022_48dp.png",
  script: "https://ssl.gstatic.com/script/images/favicon.ico",
  searchconsole: "https://ssl.gstatic.com/search-console/scfe/search_console-64.png",
  sheets: "https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico",
  slides: "https://ssl.gstatic.com/docs/presentations/images/favicon5.ico",
  tasks: "https://ssl.gstatic.com/tasks/images/favicon.ico",
  youtube: "https://www.youtube.com/s/desktop/a94e1818/img/favicon_32x32.png",
};

const getGoogleDiscoveryServiceKey = (
  source: Pick<Source, "namespace">,
): string | null => {
  const namespace = source.namespace?.trim();
  if (!namespace || !namespace.startsWith("google.")) {
    return null;
  }

  return namespace.slice("google.".length).replaceAll(".", "");
};

export const getGoogleDiscoveryIconUrl = (
  source: Pick<Source, "namespace">,
): string | null => {
  const serviceKey = getGoogleDiscoveryServiceKey(source);
  return serviceKey ? GOOGLE_DISCOVERY_SERVICE_ICONS[serviceKey] ?? null : null;
};

export const getGoogleDiscoveryIconUrlForService = (
  service: string,
): string | null => GOOGLE_DISCOVERY_SERVICE_ICONS[service.replaceAll(".", "")] ?? null;
