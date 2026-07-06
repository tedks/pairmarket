import {
  parseInviteId,
  parseMarketId,
  parseMistAmount,
  parsePositionId,
  parseSuiAddress,
  parseUnixMs,
  parseUserId,
} from "@pairmarket/core";
import { viewerMarketAction } from "../src/market-actions.ts";
import { payoutPool, sharesByOutcome } from "../src/market-selectors.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const viewerAddress = parseSuiAddress("0x1234");
const viewer = parseUserId(viewerAddress);
const other = parseUserId(parseSuiAddress("0x5678"));
const nowMs = parseUnixMs(Date.now());
const marketId = parseMarketId("0xabcd");

const state = {
  viewer,
  users: new Map(),
  friendships: [],
  friendRequests: [],
  markets: new Map(),
  intents: [],
  nowMs,
};

function market(overrides = {}) {
  return {
    id: marketId,
    creator: other,
    visibility: "friends",
    subjects: [
      {
        role: "subject-a",
        user: other,
        consent: { status: "accepted", atMs: nowMs },
      },
      {
        role: "subject-b",
        user: other,
        consent: { status: "accepted", atMs: nowMs },
      },
    ],
    operationalization: { kind: "lasts-n-dates", n: 3 },
    closeMs: parseUnixMs(nowMs + 86_400_000),
    resolutionDeadlineMs: parseUnixMs(nowMs + 2 * 86_400_000),
    challengeWindowMs: 86_400_000,
    content: { title: "Localnet market", prompt: "Private prompt" },
    phase: "trading",
    yesPoolMist: parseMistAmount(0n),
    noPoolMist: parseMistAmount(0n),
    payoutPoolMist: parseMistAmount(0n),
    yesSharesMist: parseMistAmount(0n),
    noSharesMist: parseMistAmount(0n),
    invites: [],
    positions: [],
    attestations: [],
    createdAtMs: nowMs,
    ...overrides,
  };
}

const invite = {
  id: parseInviteId("0x9999"),
  market: marketId,
  invitee: viewer,
  maxStakeMist: parseMistAmount(1_000_000_000n),
  accepted: true,
};

assert(
  viewerMarketAction(state, market({ invites: [invite] })) === "Place wager",
  "owned invite ticket makes trading market wagerable",
);

{
  const aggregateMarket = market({
    yesPoolMist: parseMistAmount(200n),
    noPoolMist: parseMistAmount(300n),
    payoutPoolMist: parseMistAmount(0n),
    yesSharesMist: parseMistAmount(200n),
    noSharesMist: parseMistAmount(300n),
    positions: [
      {
        id: parsePositionId("0x8888"),
        market: marketId,
        owner: viewer,
        outcome: "yes",
        amountMist: parseMistAmount(50n),
        claimed: false,
      },
    ],
  });
  assert(
    payoutPool(aggregateMarket) === 500n &&
      sharesByOutcome(aggregateMarket, "yes") === 200n &&
      sharesByOutcome(aggregateMarket, "no") === 300n,
    "pool selectors use chain aggregate fields, not only viewer-owned positions",
  );
}

assert(
  viewerMarketAction(
    state,
    market({
      invites: [invite],
      positions: [
        {
          id: parsePositionId("0x8888"),
          market: marketId,
          owner: viewer,
          outcome: "yes",
          amountMist: parseMistAmount(1_000_000_000n),
          claimed: false,
        },
      ],
    }),
  ) === undefined,
  "stake cap reached removes wager action",
);

assert(
  viewerMarketAction(
    state,
    market({
      phase: "proposed",
      subjects: [
        { role: "subject-a", user: viewer, consent: { status: "pending" } },
        {
          role: "subject-b",
          user: other,
          consent: { status: "accepted", atMs: nowMs },
        },
      ],
    }),
  ) === "Consent required",
  "pending subject consent is actionable",
);

assert(
  viewerMarketAction(
    state,
    market({
      phase: "attestation-pending",
      subjects: [
        {
          role: "subject-a",
          user: viewer,
          consent: { status: "accepted", atMs: nowMs },
        },
        {
          role: "subject-b",
          user: other,
          consent: { status: "accepted", atMs: nowMs },
        },
      ],
    }),
  ) === "Attest outcome",
  "subject with missing attestation is actionable",
);

assert(
  viewerMarketAction(
    state,
    market({
      phase: "settled",
      settledOutcome: "yes",
      positions: [
        {
          id: parsePositionId("0x7777"),
          market: marketId,
          owner: viewer,
          outcome: "yes",
          amountMist: parseMistAmount(1_000_000_000n),
          claimed: false,
        },
      ],
    }),
  ) === "Claim payout",
  "unclaimed winning position is actionable",
);
