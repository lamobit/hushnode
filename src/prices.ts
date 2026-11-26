import { forwardAbort, throwIfAborted } from "./abort.js";
import { readJsonWithLimit } from "./json-response.js";

export const FIAT_CURRENCIES = [
  "usd",
  "cny",
  "eur",
  "jpy",
  "gbp",
  "hkd",
  "sgd",
  "krw",
  "cad",
  "aud",
  "chf",
] as const;

export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

export type FiatPriceSource = (
  network: string,
  currency: FiatCurrency,
  addresses: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<Record<string, number>>;

export const isFiatCurrency = (value: unknown): value is FiatCurrency =>
  typeof value === "string" &&
  (FIAT_CURRENCIES as readonly string[]).includes(value);

const LLAMA_URL = "https://coins.llama.fi/prices/current/";
const FX_URL = "https://api.frankfurter.dev/v1/latest";
const FX_TTL_MS = 60 * 60_000;
const PRICE_MAX_RESPONSE_BYTES = 1024 * 1024;
const CHAIN_KEYS = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
} as const;

type UpstreamPriceResponse = {
  coins?: Record<string, { price?: unknown } | undefined>;
};

type UpstreamFxResponse = {
  rates?: Record<string, unknown>;
};

const normalizeAddress = (value: string): string => value.toLowerCase();

const parsePrice = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
};

const parseFxRate = (payload: unknown, currency: FiatCurrency): number => {
  const rates = (payload as UpstreamFxResponse | null)?.rates;
  const rate = parsePrice(rates?.[currency.toUpperCase()]);
  if (rate === null) {
    throw new Error(`FX rate is unavailable for ${currency}.`);
  }
  return rate;
};

const requestJson = async (
  url: string,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<unknown> => {
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Price upstream returned ${response.status}.`);
  }
  return await readJsonWithLimit(
    response,
    PRICE_MAX_RESPONSE_BYTES,
    signal,
  );
};

export const createFiatPriceSource = (
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): FiatPriceSource => {
  const request = options.fetchImpl ?? fetch;
  const fxCache = new Map<FiatCurrency, { rate: number; fetchedAt: number }>();

  const loadFxRate = async (
    currency: FiatCurrency,
    signal: AbortSignal,
  ): Promise<number> => {
    if (currency === "usd") return 1;
    const cached = fxCache.get(currency);
    if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) {
      return cached.rate;
    }
    const params = new URLSearchParams({
      base: "USD",
      symbols: currency.toUpperCase(),
    });
    const payload = await requestJson(
      `${FX_URL}?${params.toString()}`,
      signal,
      request,
    );
    const rate = parseFxRate(payload, currency);
    fxCache.set(currency, { rate, fetchedAt: Date.now() });
    return rate;
  };

  return async (network, currency, addresses, options = {}) => {
    if (addresses.length === 0) return {};
    const chain = CHAIN_KEYS[network as keyof typeof CHAIN_KEYS];
    if (!chain) {
      throw new Error(`Price chain is unsupported: ${network}`);
    }
    const requested = new Set(addresses.map(normalizeAddress).filter(Boolean));
    if (requested.size === 0) return {};

    const controller = new AbortController();
    const detachAbort = forwardAbort(options.signal, controller);
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      throwIfAborted(controller.signal);
      const coins = [...requested].map((address) => `${chain}:${address}`).join(",");
      const [pricePayload, fxRate] = await Promise.all([
        requestJson(`${LLAMA_URL}${coins}`, controller.signal, request),
        loadFxRate(currency, controller.signal),
      ]);
      const response = pricePayload as UpstreamPriceResponse;
      const prefix = `${chain}:`;
      const prices: Record<string, number> = {};
      for (const [key, values] of Object.entries(response.coins ?? {})) {
        if (!key.toLowerCase().startsWith(prefix)) continue;
        const price = parsePrice(values?.price);
        if (price === null) continue;
        const address = normalizeAddress(key.slice(prefix.length));
        if (!requested.has(address)) continue;
        const converted = price * fxRate;
        if (Number.isFinite(converted) && converted > 0) {
          prices[address] = converted;
        }
      }
      return prices;
    } finally {
      detachAbort();
      controller.abort();
      clearTimeout(timeout);
    }
  };
};
