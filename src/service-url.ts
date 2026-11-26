export const HTTP_URL_PROTOCOLS = new Set(["http:", "https:"]);
export const RPC_URL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export const DEFAULT_MAX_SERVICE_URL_LENGTH = 2_048;

export type NormalizeServiceUrlOptions = {
  maxLength?: number;
  stripTrailingSlash?: boolean;
};

export const normalizeServiceUrl = (
  raw: unknown,
  protocols: ReadonlySet<string>,
  options: NormalizeServiceUrlOptions = {},
): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  const maxLength = options.maxLength ?? DEFAULT_MAX_SERVICE_URL_LENGTH;
  if (!value || value.length > maxLength) return undefined;

  try {
    const url = new URL(value);
    if (!protocols.has(url.protocol) || !url.hostname) return undefined;
    if (url.href.length > maxLength) return undefined;
    return options.stripTrailingSlash
      ? value.replace(/\/$/, "")
      : value;
  } catch {
    return undefined;
  }
};
