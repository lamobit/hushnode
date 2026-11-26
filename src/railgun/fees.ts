// RAILGUN proxy fee getters. Keep this list in sync with the engine's
// provider health check so both paths validate the same RPC surface.
export const RAILGUN_FEE_SELECTORS = [
  "0x01c37790", // shieldFee()
  "0x053ed12a", // unshieldFee()
  "0x9071adc0", // nftFee()
] as const;
