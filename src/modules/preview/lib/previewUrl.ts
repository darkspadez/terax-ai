const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

export function loopbackPreviewOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      hostname !== "0.0.0.0" &&
      hostname !== "[::1]" &&
      !IPV4_LOOPBACK.test(hostname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The preview tab a link clicked in a terminal should land in: null when the
 * link goes to the browser (the setting is off, or it is not a local dev
 * server), otherwise the id of a preview tab of this space already showing
 * it (0 when a new one is needed).
 */
export function terminalLinkPreviewTarget(
  url: string,
  enabled: boolean,
  tabs: readonly { id: number; kind: string; spaceId?: string; url?: string }[],
  spaceId: string | null,
): number | null {
  if (!enabled || loopbackPreviewOrigin(url) === null) return null;
  const open = tabs.find(
    (tab) =>
      tab.kind === "preview" &&
      tab.url === url &&
      (spaceId === null || tab.spaceId === spaceId),
  );
  return open?.id ?? 0;
}
