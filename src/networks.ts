import {
  ChainType,
  NetworkName,
  RailgunProxyDeploymentBlock,
  type Chain,
  type ProviderJson,
} from "@railgun-community/shared-models";
import {
  RPC_URL_PROTOCOLS,
  normalizeServiceUrl,
} from "./service-url.js";

export type TokenDefinition = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

export type NetworkDefinition = {
  id: NetworkName;
  label: string;
  chainId: number;
  chainType: ChainType;
  nativeSymbol: string;
  nativeName: string;
  nativeDecimals: number;
  wrappedAddress: string;
  blockscan: string;
  blockscout: string;
  defillamaKey?: string;
  accent: string;
  providers: string[];
  tokens: TokenDefinition[];
};

export const DEFAULT_NETWORK = NetworkName.Ethereum;

export const railgunDeploymentBlock = (network: NetworkName): number =>
  RailgunProxyDeploymentBlock[network];

const token = (
  address: string,
  symbol: string,
  name: string,
  decimals: number,
): TokenDefinition => ({ address, symbol, name, decimals });

export const NETWORKS: NetworkDefinition[] = [
  {
    id: NetworkName.Ethereum,
    label: "Ethereum",
    chainId: 1,
    chainType: ChainType.EVM,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    wrappedAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    blockscan: "https://etherscan.io",
    blockscout: "https://eth.blockscout.com",
    defillamaKey: "ethereum",
    accent: "#8c9eff",
    providers: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://rpc.flashbots.net",
      "https://eth.meowrpc.com",
    ],
    tokens: [
      token("0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", "Tether USD", 6),
      token("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "WETH", "Wrapped Ether", 18),
      token("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "WBTC", "Wrapped Bitcoin", 8),
      token("0x6b175474e89094c44da98b954eedeac495271d0f", "DAI", "Dai Stablecoin", 18),
      token("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC", "USD Coin", 6),
      token("0xe76c6c83af64e4c60245d8c7de953df673a7a33d", "RAIL", "Railgun", 18),
      token("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "wstETH", "Wrapped stETH", 18),
      token("0x085780639cc2cacd35e474e71f4d000e2405d8f6", "fxUSD", "f(x) USD", 18),
    ],
  },
  {
    id: NetworkName.Arbitrum,
    label: "Arbitrum",
    chainId: 42161,
    chainType: ChainType.EVM,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    wrappedAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    blockscan: "https://arbiscan.io",
    blockscout: "https://arbitrum.blockscout.com",
    defillamaKey: "arbitrum",
    accent: "#39c6ff",
    providers: [
      "https://arbitrum-one.publicnode.com",
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.drpc.org",
      "https://arbitrum-one.public.blastapi.io",
    ],
    tokens: [
      token(
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        "USDC",
        "USD Coin",
        6,
      ),
      token("0x912ce59144191c1204e64559fe8253a0e49e6548", "ARB", "Arbitrum", 18),
      token("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT", "Tether USD", 6),
      token("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "USDC", "USD Coin", 6),
      token("0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "DAI", "Dai Stablecoin", 18),
      token("0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0", "UNI", "Uniswap", 18),
      token("0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "WBTC", "Wrapped Bitcoin", 8),
      token("0x4d15a3a2286d883af0aa1b3f21367843fac63e07", "TUSD", "TrueUSD", 18),
      token("0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "WETH", "Wrapped Ether", 18),
    ],
  },
];

export const NETWORK_BY_ID = new Map(
  NETWORKS.map((network) => [network.id, network]),
);

export const MAX_PROVIDER_URLS_PER_NETWORK = 12;

export const normalizeProviderUrls = (
  values: readonly unknown[],
  limit = MAX_PROVIDER_URLS_PER_NETWORK,
): string[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Provider URL limit must be a positive integer.");
  }
  const providers: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const provider = normalizeServiceUrl(value, RPC_URL_PROTOCOLS);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
    if (providers.length >= limit) break;
  }
  return providers;
};

const RPC_ENV_KEYS: Partial<Record<NetworkName, string>> = {
  [NetworkName.Ethereum]: "HUSH_NODE_ETHEREUM_RPC",
  [NetworkName.Arbitrum]: "HUSH_NODE_ARBITRUM_RPC",
};

export const applyProviderOverrides = (): void => {
  for (const network of NETWORKS) {
    const envKey = RPC_ENV_KEYS[network.id];
    if (!envKey) continue;
    const configured = normalizeProviderUrls(
      (process.env[envKey] ?? "").split(/[\s,]+/),
    );
    if (configured.length === 0) continue;
    network.providers = configured;
  }
};

applyProviderOverrides();

export const networkFor = (id: NetworkName): NetworkDefinition => {
  const found = NETWORK_BY_ID.get(id);
  if (!found) throw new Error(`Unsupported network: ${id}`);
  return found;
};

export const isSupportedNetwork = (
  value: string | undefined,
): value is NetworkName =>
  Boolean(value) && NETWORKS.some((network) => network.id === value);

export const resolveStoredNetwork = (
  value: string | undefined,
): { network: NetworkName; fellBack: boolean } => {
  if (isSupportedNetwork(value)) {
    return { network: value, fellBack: false };
  }
  return {
    network: DEFAULT_NETWORK,
    fellBack: Boolean(value),
  };
};

export const networkForChainId = (chainId: number): NetworkDefinition | undefined =>
  NETWORKS.find((network) => network.chainId === chainId);

export const chainFor = (network: NetworkDefinition): Chain => ({
  type: network.chainType,
  id: network.chainId,
});

export const providerObjects = (network: NetworkDefinition): ProviderJson[] =>
  network.providers.map((provider) => ({
    provider,
    priority: 3,
    weight: 2,
    stallTimeout: 2500,
    maxLogsPerBatch: 2,
  }));

export const networkNameFromUnknown = (
  value: string | undefined,
): NetworkName | undefined => {
  if (!value) return undefined;
  return NETWORKS.find(
    (network) =>
      network.id === value ||
      network.label.toLowerCase() === value.toLowerCase(),
  )?.id;
};
