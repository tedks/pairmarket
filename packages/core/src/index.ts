export const toolchainPins = {
  node: "24.15.0",
  pnpm: "11.9.0",
  suiCli: "mainnet-v1.73.2",
  mystenSui: "2.20.1",
  mystenWalrus: "1.2.3",
  mystenSeal: "1.2.3",
  typescript: "6.0.3",
} as const;

export type ToolchainPins = typeof toolchainPins;
