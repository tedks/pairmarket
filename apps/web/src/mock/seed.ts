import {
  parseInviteId,
  parseMarketId,
  parseMistAmount,
  parsePositionId,
  parseSuiAddress,
  parseUnixMs,
  parseUserId,
} from "@pairmarket/core";
import type {
  InviteId,
  MarketId,
  MistAmount,
  PositionId,
  UnixMs,
  UserId,
} from "@pairmarket/core";
import type { AppState, Market, UserProfile } from "../types.ts";

// Seed time anchor: stable so the UI is reproducible in tests.
const NOW_MS: UnixMs = parseUnixMs(Date.UTC(2026, 5, 27, 16, 0, 0));
const ONE_DAY_MS = 86_400_000;

function user(
  id: string,
  handle: string,
  displayName: string,
  address: string,
): UserProfile {
  return {
    id: parseUserId(id),
    handle,
    displayName,
    address: parseSuiAddress(address),
  };
}

function mist(sui: number): MistAmount {
  return parseMistAmount(BigInt(Math.round(sui * 1_000_000_000)));
}

function mid(hex: string): MarketId {
  return parseMarketId(hex);
}

function iid(label: string): InviteId {
  return parseInviteId(label);
}

function pid(hex: string): PositionId {
  return parsePositionId(hex);
}

const ada = user("ada-lovelace", "ada", "Ada Lovelace", "0xada");
const ben = user("ben-okri", "ben", "Ben Okri", "0xbe7");
const cleo = user("cleo-park", "cleo", "Cleo Park", "0xc1e0");
const dru = user("dru-haines", "dru", "Dru Haines", "0xd121");
const eli = user("eli-mensah", "eli", "Eli Mensah", "0xe11");
const fae = user("fae-shimizu", "fae", "Fae Shimizu", "0xfae");

export const SEED_USERS: readonly UserProfile[] = [
  ada,
  ben,
  cleo,
  dru,
  eli,
  fae,
];

// Reference user for the prototype's first viewport. Switchable from the
// header chip; defaulting to the creator gives the most operational view.
export const SEED_VIEWER: UserId = ada.id;

function market(args: {
  id: string;
  creator: UserId;
  subjectA: UserId;
  subjectB: UserId;
  title: string;
  prompt: string;
  phase: Market["phase"];
  operationalization: Market["operationalization"];
  resolutionDeadlineMs: UnixMs;
  challengeWindowMs: number;
  createdAtMs: UnixMs;
  subjectAConsent: Market["subjects"][number]["consent"];
  subjectBConsent: Market["subjects"][number]["consent"];
  invites: ReadonlyArray<{
    id: InviteId;
    invitee: UserId;
    maxStakeMist: MistAmount;
    accepted: boolean;
  }>;
  positions: ReadonlyArray<{
    id: PositionId;
    owner: UserId;
    outcome: "yes" | "no";
    amountMist: MistAmount;
    claimed: boolean;
  }>;
  attestations?: Market["attestations"];
  settledOutcome?: "yes" | "no" | "invalid";
}): Market {
  const id = mid(args.id);
  return {
    id,
    creator: args.creator,
    subjects: [
      { role: "subject-a", user: args.subjectA, consent: args.subjectAConsent },
      { role: "subject-b", user: args.subjectB, consent: args.subjectBConsent },
    ],
    operationalization: args.operationalization,
    resolutionDeadlineMs: args.resolutionDeadlineMs,
    challengeWindowMs: args.challengeWindowMs,
    content: { title: args.title, prompt: args.prompt },
    phase: args.phase,
    invites: args.invites.map((i) => ({
      id: i.id,
      market: id,
      invitee: i.invitee,
      maxStakeMist: i.maxStakeMist,
      accepted: i.accepted,
    })),
    positions: args.positions.map((p) => ({
      id: p.id,
      market: id,
      owner: p.owner,
      outcome: p.outcome,
      amountMist: p.amountMist,
      claimed: p.claimed,
    })),
    attestations: args.attestations ?? [],
    ...(args.settledOutcome !== undefined
      ? { settledOutcome: args.settledOutcome }
      : {}),
    createdAtMs: args.createdAtMs,
  };
}

const trading = market({
  id: "0x" + "11".padStart(64, "0"),
  creator: ada.id,
  subjectA: cleo.id,
  subjectB: dru.id,
  title: "Will Cleo and Dru last 3 dates?",
  prompt:
    "Three dates means three meetings of at least 90 minutes with mutual intent; subjects co-attest after the third or by the deadline.",
  phase: "trading",
  operationalization: { kind: "lasts-n-dates", n: 3 },
  resolutionDeadlineMs: parseUnixMs(NOW_MS + 21 * ONE_DAY_MS),
  challengeWindowMs: 2 * ONE_DAY_MS,
  createdAtMs: parseUnixMs(NOW_MS - 2 * ONE_DAY_MS),
  subjectAConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - ONE_DAY_MS),
  },
  subjectBConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - ONE_DAY_MS),
  },
  invites: [
    {
      id: iid("inv-trading-ben"),
      invitee: ben.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
    {
      id: iid("inv-trading-eli"),
      invitee: eli.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
    {
      id: iid("inv-trading-fae"),
      invitee: fae.id,
      maxStakeMist: mist(2),
      accepted: false,
    },
  ],
  positions: [
    {
      id: pid("0x" + "a1".padStart(64, "0")),
      owner: ben.id,
      outcome: "yes",
      amountMist: mist(1.5),
      claimed: false,
    },
    {
      id: pid("0x" + "a2".padStart(64, "0")),
      owner: eli.id,
      outcome: "no",
      amountMist: mist(0.5),
      claimed: false,
    },
  ],
});

const proposed = market({
  id: "0x" + "22".padStart(64, "0"),
  creator: ada.id,
  subjectA: eli.id,
  subjectB: fae.id,
  title: "Will Eli and Fae go on a second date if introduced?",
  prompt: "Second date = a planned one-on-one meeting after an introduction.",
  phase: "proposed",
  operationalization: {
    kind: "meet-by-date",
    deadlineMs: parseUnixMs(NOW_MS + 30 * ONE_DAY_MS),
  },
  resolutionDeadlineMs: parseUnixMs(NOW_MS + 35 * ONE_DAY_MS),
  challengeWindowMs: 2 * ONE_DAY_MS,
  createdAtMs: parseUnixMs(NOW_MS - 3 * 3600_000),
  subjectAConsent: { status: "accepted", atMs: parseUnixMs(NOW_MS - 3600_000) },
  // Pending — this is the consent prompt the viewer (when switched to Fae)
  // is the natural blocker for.
  subjectBConsent: { status: "pending" },
  invites: [
    {
      id: iid("inv-prop-ben"),
      invitee: ben.id,
      maxStakeMist: mist(1),
      accepted: false,
    },
    {
      id: iid("inv-prop-cleo"),
      invitee: cleo.id,
      maxStakeMist: mist(1),
      accepted: false,
    },
  ],
  positions: [],
});

const attestationPending = market({
  id: "0x" + "33".padStart(64, "0"),
  creator: ben.id,
  subjectA: ada.id,
  subjectB: cleo.id,
  title: "Will Ada and Cleo still be together end of Q4?",
  prompt: "Together = self-reported relationship status, co-attested.",
  phase: "attestation-pending",
  operationalization: {
    kind: "together-by-date",
    deadlineMs: parseUnixMs(NOW_MS + 5 * ONE_DAY_MS),
  },
  resolutionDeadlineMs: parseUnixMs(NOW_MS + 5 * ONE_DAY_MS),
  challengeWindowMs: 2 * ONE_DAY_MS,
  createdAtMs: parseUnixMs(NOW_MS - 60 * ONE_DAY_MS),
  subjectAConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - 59 * ONE_DAY_MS),
  },
  subjectBConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - 59 * ONE_DAY_MS),
  },
  invites: [
    {
      id: iid("inv-attest-dru"),
      invitee: dru.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
    {
      id: iid("inv-attest-eli"),
      invitee: eli.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
  ],
  positions: [
    {
      id: pid("0x" + "b1".padStart(64, "0")),
      owner: dru.id,
      outcome: "yes",
      amountMist: mist(1.5),
      claimed: false,
    },
    {
      id: pid("0x" + "b2".padStart(64, "0")),
      owner: eli.id,
      outcome: "no",
      amountMist: mist(1.0),
      claimed: false,
    },
  ],
});

const settled = market({
  id: "0x" + "44".padStart(64, "0"),
  creator: cleo.id,
  subjectA: ben.id,
  subjectB: dru.id,
  title: "Did Ben and Dru last 3 dates?",
  prompt:
    "Settled YES after subject co-attestation; challenge window closed clean.",
  phase: "settled",
  operationalization: { kind: "lasts-n-dates", n: 3 },
  resolutionDeadlineMs: parseUnixMs(NOW_MS - 7 * ONE_DAY_MS),
  challengeWindowMs: 2 * ONE_DAY_MS,
  createdAtMs: parseUnixMs(NOW_MS - 90 * ONE_DAY_MS),
  subjectAConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - 89 * ONE_DAY_MS),
  },
  subjectBConsent: {
    status: "accepted",
    atMs: parseUnixMs(NOW_MS - 89 * ONE_DAY_MS),
  },
  invites: [
    {
      id: iid("inv-settle-ada"),
      invitee: ada.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
    {
      id: iid("inv-settle-eli"),
      invitee: eli.id,
      maxStakeMist: mist(2),
      accepted: true,
    },
  ],
  positions: [
    {
      id: pid("0x" + "c1".padStart(64, "0")),
      owner: ada.id,
      outcome: "yes",
      amountMist: mist(1.0),
      claimed: false,
    },
    {
      id: pid("0x" + "c2".padStart(64, "0")),
      owner: eli.id,
      outcome: "no",
      amountMist: mist(0.5),
      claimed: true,
    },
  ],
  attestations: [
    {
      attestor: ben.id,
      outcome: "yes",
      atMs: parseUnixMs(NOW_MS - 9 * ONE_DAY_MS),
    },
    {
      attestor: dru.id,
      outcome: "yes",
      atMs: parseUnixMs(NOW_MS - 9 * ONE_DAY_MS),
    },
  ],
  settledOutcome: "yes",
});

export const SEED_MARKETS: readonly Market[] = [
  trading,
  proposed,
  attestationPending,
  settled,
];

export function seedAppState(): AppState {
  const users = new Map<UserId, UserProfile>();
  for (const u of SEED_USERS) users.set(u.id, u);
  const markets = new Map<MarketId, Market>();
  for (const m of SEED_MARKETS) markets.set(m.id, m);
  return {
    viewer: SEED_VIEWER,
    users,
    markets,
    intents: [],
    nowMs: NOW_MS,
  };
}

export const SEED_NOW_MS = NOW_MS;
