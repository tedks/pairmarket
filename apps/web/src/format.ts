import type { MarketId, MistAmount, UnixMs, UserId } from "@pairmarket/core";
import type { Market } from "./types.ts";

export function formatSui(amount: MistAmount | bigint): string {
  const mist = amount as bigint;
  const whole = mist / 1_000_000_000n;
  const frac = mist % 1_000_000_000n;
  if (frac === 0n) return `${whole.toString()} SUI`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr} SUI`;
}

export function formatAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatMarketId(id: MarketId): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatUserId(id: UserId): string {
  return id;
}

const PHASE_LABEL: Record<Market["phase"], string> = {
  draft: "Draft",
  proposed: "Awaiting consent",
  trading: "Trading",
  locked: "Locked",
  "attestation-pending": "Attestation",
  "challenge-window-open": "Challenge window",
  settled: "Settled",
  cancelled: "Cancelled",
  expired: "Expired",
  "invalid-refund": "Invalid · refunded",
};

export function phaseLabel(phase: Market["phase"]): string {
  return PHASE_LABEL[phase];
}

export function formatDuration(nowMs: UnixMs, targetMs: UnixMs): string {
  const delta = (targetMs as number) - (nowMs as number);
  const sign = delta < 0 ? "ago" : "in";
  const abs = Math.abs(delta);
  const day = 86_400_000;
  const hour = 3_600_000;
  if (abs >= day) {
    const d = Math.round(abs / day);
    return `${sign} ${d}d`;
  }
  if (abs >= hour) {
    const h = Math.round(abs / hour);
    return `${sign} ${h}h`;
  }
  const m = Math.max(1, Math.round(abs / 60_000));
  return `${sign} ${m}m`;
}

export function operationalizationLabel(
  op: Market["operationalization"],
): string {
  switch (op.kind) {
    case "lasts-n-dates":
      return `Lasts ${op.n} dates`;
    case "together-by-date":
      return `Together by ${formatDate(op.deadlineMs)}`;
    case "meet-by-date":
      return `Meet by ${formatDate(op.deadlineMs)}`;
  }
}

export function formatDate(ms: UnixMs): string {
  const d = new Date(ms as number);
  return d.toISOString().slice(0, 10);
}
