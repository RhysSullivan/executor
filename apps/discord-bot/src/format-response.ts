export interface FormattedDiscordResponse {
  message: string;
  footer?: string;
}

export function formatDiscordResponse(params: {
  text: string;
  footer?: string | undefined;
}): FormattedDiscordResponse {
  const message = params.text.trim().length > 0 ? params.text.trim() : "Done.";

  return {
    message: truncateDiscord(message),
    ...(params.footer ? { footer: truncateFooter(params.footer) } : {}),
  };
}

function truncateDiscord(value: string): string {
  const limit = 1_900;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...`;
}

function truncateFooter(value: string): string {
  const limit = 350;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 3)}...`;
}
