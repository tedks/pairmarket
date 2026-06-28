import { parseNonce, parsePositionId, parseUnixMs } from "@pairmarket/core";
import type {
  AcceptInviteTxSpec,
  ClaimPayoutTxSpec,
  ConsentAsSubjectTxSpec,
  CreateMarketTxSpec,
  MistAmount,
  Nonce,
  PlaceWagerTxSpec,
  PositionId,
  SubmitAttestationTxSpec,
  SuiAddress,
  TxIntent,
  TxKind,
  TxSpec,
  TxSpecFor,
  UnixMs,
  WagerOutcome,
} from "@pairmarket/core";
import type {
  AppState,
  Attestation,
  IntentRecord,
  Invite,
  Market,
  OperationalizationKind,
  Position,
  Subject,
  SubjectRole,
} from "../types.ts";
import { parseInviteId, parseMarketId, parseUserId } from "@pairmarket/core";

type Brander = <K extends TxKind>(spec: TxSpecFor<K>) => TxIntent<K>;
// The brand is structural; cast is the only mint. Wrapping the cast here
// concentrates the unsafe step so callers stay branded-end-to-end.
const brand: Brander = ((spec: TxSpec) =>
  spec as unknown as TxIntent) as Brander;

function nonce(): Nonce {
  // crypto.randomUUID() is 36 chars; NONCE_RE accepts [A-Za-z0-9_-]{22,512}.
  return parseNonce(crypto.randomUUID());
}

function termsHash(
  market: Pick<
    Market,
    | "content"
    | "operationalization"
    | "resolutionDeadlineMs"
    | "challengeWindowMs"
  >,
): string {
  // Stand-in for the on-chain terms_hash — stable, content-derived,
  // deterministic for the prototype.
  const parts = [
    market.content.title,
    market.content.prompt,
    JSON.stringify(market.operationalization),
    String(market.resolutionDeadlineMs),
    String(market.challengeWindowMs),
  ];
  let h = 0xcbf29ce484222325n;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = BigInt.asUintN(64, (h ^ BigInt(part.charCodeAt(i))) * 0x100000001b3n);
    }
    h = BigInt.asUintN(64, (h ^ 0x2cn) * 0x100000001b3n);
  }
  return `0x${h.toString(16).padStart(16, "0")}`;
}

function digest(): string {
  // Pseudo-digest for the mock intent log — TxDigest parses base58, which
  // is overkill for an in-memory marker.
  return crypto.randomUUID().replace(/-/g, "");
}

function recordIntent<K extends TxKind>(
  state: AppState,
  kind: K,
  intent: TxIntent<K>,
): IntentRecord {
  return {
    digest: digest(),
    kind,
    intent,
    atMs: state.nowMs,
  };
}

function nextPositionId(market: Market): PositionId {
  // Synthetic: 0x-prefixed counter scoped to the market.
  const count = market.positions.length + 1;
  const hex = count.toString(16);
  return parsePositionId(
    `0x${(market.id.slice(2, 10) + hex).padStart(64, "0")}`,
  );
}

function nextMarketId(state: AppState): ReturnType<typeof parseMarketId> {
  const count = state.markets.size + 1;
  const hex = (0x100 + count).toString(16);
  return parseMarketId(`0x${hex.padStart(64, "0")}`);
}

function updateMarket(
  state: AppState,
  market: Market,
  intent: IntentRecord,
): AppState {
  const markets = new Map(state.markets);
  markets.set(market.id, market);
  return { ...state, markets, intents: [intent, ...state.intents] };
}

function senderAddress(
  state: AppState,
  userId: ReturnType<typeof parseUserId>,
): SuiAddress {
  const profile = state.users.get(userId);
  if (!profile) throw new Error(`Unknown user ${userId}`);
  return profile.address;
}

export type CreateMarketInput = {
  readonly title: string;
  readonly prompt: string;
  readonly subjectA: ReturnType<typeof parseUserId>;
  readonly subjectB: ReturnType<typeof parseUserId>;
  readonly operationalization: OperationalizationKind;
  readonly resolutionDeadlineMs: UnixMs;
  readonly challengeWindowMs: number;
  readonly invitees: ReadonlyArray<{
    readonly invitee: ReturnType<typeof parseUserId>;
    readonly maxStakeMist: MistAmount;
  }>;
};

export function createMarketDraft(
  state: AppState,
  input: CreateMarketInput,
): AppState {
  if (
    input.operationalization.kind !== "lasts-n-dates" &&
    (input.operationalization.deadlineMs as number) >
      (input.resolutionDeadlineMs as number)
  ) {
    throw new Error(
      "operationalization deadline must be on or before resolution deadline",
    );
  }

  const id = nextMarketId(state);
  const subjectA: Subject = {
    role: "subject-a",
    user: input.subjectA,
    consent:
      input.subjectA === state.viewer
        ? { status: "accepted", atMs: state.nowMs }
        : { status: "pending" },
  };
  const subjectB: Subject = {
    role: "subject-b",
    user: input.subjectB,
    consent:
      input.subjectB === state.viewer
        ? { status: "accepted", atMs: state.nowMs }
        : { status: "pending" },
  };
  const invites: Invite[] = input.invitees.map((inv, idx) => ({
    id: parseInviteId(`inv-${id.slice(2, 10)}-${idx}-${inv.invitee}`),
    market: id,
    invitee: inv.invitee,
    maxStakeMist: inv.maxStakeMist,
    accepted: false,
  }));
  const market: Market = {
    id,
    creator: state.viewer,
    subjects: [subjectA, subjectB],
    operationalization: input.operationalization,
    resolutionDeadlineMs: input.resolutionDeadlineMs,
    challengeWindowMs: input.challengeWindowMs,
    content: { title: input.title, prompt: input.prompt },
    phase:
      subjectA.consent.status === "accepted" &&
      subjectB.consent.status === "accepted"
        ? "trading"
        : "proposed",
    invites,
    positions: [],
    attestations: [],
    createdAtMs: state.nowMs,
  };
  const spec: CreateMarketTxSpec = {
    kind: "create-market",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    payload: { termsHash: termsHash(market) },
  };
  const intent = brand(spec);
  return updateMarket(
    state,
    market,
    recordIntent(state, "create-market", intent),
  );
}

export function consentAsSubject(
  state: AppState,
  marketId: Market["id"],
  role: SubjectRole,
  decision: "accept" | "decline",
): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  const subjects = existing.subjects.map((s) => {
    if (s.role !== role) return s;
    if (s.user !== state.viewer) {
      throw new Error("viewer is not the subject for this role");
    }
    return {
      ...s,
      consent:
        decision === "accept"
          ? ({ status: "accepted", atMs: state.nowMs } as const)
          : ({ status: "declined", atMs: state.nowMs } as const),
    };
  }) as unknown as readonly [Subject, Subject];

  const bothAccepted = subjects.every((s) => s.consent.status === "accepted");
  const anyDeclined = subjects.some((s) => s.consent.status === "declined");
  const phase: Market["phase"] = anyDeclined
    ? "cancelled"
    : bothAccepted
      ? "trading"
      : "proposed";

  const market: Market = { ...existing, subjects, phase };
  const spec: ConsentAsSubjectTxSpec = {
    kind: "consent-as-subject",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { termsHash: termsHash(market), subjectRole: role },
  };
  return updateMarket(
    state,
    market,
    recordIntent(state, "consent-as-subject", brand(spec)),
  );
}

export function acceptInvite(
  state: AppState,
  marketId: Market["id"],
  inviteId: Invite["id"],
): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  const invites = existing.invites.map((i) =>
    i.id === inviteId ? { ...i, accepted: true } : i,
  );
  const market: Market = { ...existing, invites };
  const spec: AcceptInviteTxSpec = {
    kind: "accept-invite",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { invite: inviteId },
  };
  return updateMarket(
    state,
    market,
    recordIntent(state, "accept-invite", brand(spec)),
  );
}

export function placeWager(
  state: AppState,
  marketId: Market["id"],
  outcome: WagerOutcome,
  amountMist: MistAmount,
): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  if (existing.phase !== "trading") {
    throw new Error(`market not trading (phase=${existing.phase})`);
  }
  const invite = existing.invites.find(
    (i) => i.invitee === state.viewer && i.accepted,
  );
  if (!invite) throw new Error("viewer has no accepted invite");
  const alreadyStaked = existing.positions
    .filter((p) => p.owner === state.viewer)
    .reduce<bigint>((sum, p) => sum + p.amountMist, 0n);
  if (alreadyStaked + amountMist > invite.maxStakeMist) {
    throw new Error("stake exceeds invite cap");
  }
  const position: Position = {
    id: nextPositionId(existing),
    market: marketId,
    owner: state.viewer,
    outcome,
    amountMist,
    claimed: false,
  };
  const market: Market = {
    ...existing,
    positions: [...existing.positions, position],
  };
  const spec: PlaceWagerTxSpec = {
    kind: "place-wager",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { outcome, amountMist },
  };
  return updateMarket(
    state,
    market,
    recordIntent(state, "place-wager", brand(spec)),
  );
}

export function lockMarket(state: AppState, marketId: Market["id"]): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  if (existing.phase !== "trading") return state;
  const market: Market = { ...existing, phase: "attestation-pending" };
  // No tx kind for lock in the mock — protocol drives it via Clock. Log
  // an attestation-pending marker via a synthetic intent so the UI shows
  // the transition.
  const intent = brand<"submit-attestation">({
    kind: "submit-attestation",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { outcome: "yes" },
  } satisfies SubmitAttestationTxSpec);
  return updateMarket(
    state,
    market,
    recordIntent(state, "submit-attestation", intent),
  );
}

export function submitAttestation(
  state: AppState,
  marketId: Market["id"],
  outcome: "yes" | "no" | "invalid",
): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  if (existing.phase !== "attestation-pending") {
    throw new Error(
      `market not awaiting attestation (phase=${existing.phase})`,
    );
  }
  const subject = existing.subjects.find((s) => s.user === state.viewer);
  if (!subject) throw new Error("viewer is not a subject");

  const attestation: Attestation = {
    attestor: state.viewer,
    outcome,
    atMs: state.nowMs,
  };
  const attestations = [
    ...existing.attestations.filter((a) => a.attestor !== state.viewer),
    attestation,
  ];

  const matched =
    attestations.length === 2 &&
    attestations[0]!.outcome === attestations[1]!.outcome;
  const market: Market = matched
    ? {
        ...existing,
        attestations,
        phase: "settled",
        settledOutcome: attestations[0]!.outcome,
      }
    : { ...existing, attestations, phase: "attestation-pending" };

  const spec: SubmitAttestationTxSpec = {
    kind: "submit-attestation",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { outcome },
  };
  return updateMarket(
    state,
    market,
    recordIntent(state, "submit-attestation", brand(spec)),
  );
}

export function claimPayout(
  state: AppState,
  marketId: Market["id"],
  positionId: PositionId,
): AppState {
  const existing = state.markets.get(marketId);
  if (!existing) throw new Error("market missing");
  if (existing.phase !== "settled") throw new Error("market not settled");
  const winning = existing.settledOutcome;
  if (winning === undefined) throw new Error("no settlement outcome");

  const positions = existing.positions.map((p) => {
    if (p.id !== positionId) return p;
    if (p.owner !== state.viewer) {
      throw new Error("viewer does not own position");
    }
    if (p.claimed) throw new Error("position already claimed");
    if (winning === "invalid" || p.outcome === winning) {
      return { ...p, claimed: true };
    }
    throw new Error("position is not on the winning side");
  });

  const market: Market = { ...existing, positions };
  const spec: ClaimPayoutTxSpec = {
    kind: "claim-payout",
    sender: senderAddress(state, state.viewer),
    nonce: nonce(),
    market: marketId,
    payload: { position: positionId },
  };
  return updateMarket(
    state,
    market,
    recordIntent(state, "claim-payout", brand(spec)),
  );
}

export function setNow(state: AppState, now: number): AppState {
  return { ...state, nowMs: parseUnixMs(now) };
}

// Helpers for UI components — derived selectors.
export function payoutPool(market: Market): bigint {
  return market.positions.reduce(
    (acc, p) => acc + (p.amountMist as bigint),
    0n,
  );
}

export function sharesByOutcome(market: Market, outcome: WagerOutcome): bigint {
  return market.positions
    .filter((p) => p.outcome === outcome)
    .reduce((acc, p) => acc + (p.amountMist as bigint), 0n);
}

export function viewerIsMember(state: AppState, market: Market): boolean {
  if (market.creator === state.viewer) return true;
  if (market.subjects.some((s) => s.user === state.viewer)) return true;
  if (market.invites.some((i) => i.invitee === state.viewer)) return true;
  return false;
}
