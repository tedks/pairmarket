import {
  createTxIntent,
  defineSigningCustodyScope,
  parseMarketId,
  parseMistAmount,
  parseNonce,
  parsePreviewHash,
  parseSessionId,
  parseSuiAddress,
  parseUserId,
} from "@pairmarket/core";
import {
  createInMemoryWalletService,
  previewHashForPrototype,
} from "../src/index.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }

  throw new Error(message);
}

function custodyCap(input) {
  return input;
}

const auditEvents = [];
const wallet = createInMemoryWalletService({
  nowMs: () => 1234,
  auditSink: (event) => auditEvents.push(event),
  keyRefFingerprintSalt: "test-salt",
});
const userId = parseUserId("twitter:wallet-runtime-user");
const account = wallet.provisionCustodialAccount({ userId });
const marketId = parseMarketId("0x2");
const nonce = parseNonce("runtime-wallet-nonce-01");
const amount = parseMistAmount(10n);
const sessionIds = [
  "runtime-wallet-session1",
  "runtime-wallet-session2",
  "runtime-wallet-session3",
  "runtime-wallet-session4",
  "runtime-wallet-session5",
  "runtime-wallet-session6",
].map((sessionId) => parseSessionId(sessionId));

for (const sessionId of sessionIds) {
  wallet.registerSession({ userId, sessionId });
}

const otherUserId = parseUserId("twitter:wallet-runtime-other");
wallet.provisionCustodialAccount({ userId: otherUserId });
assertThrows(
  () => wallet.registerSession({ userId: otherUserId, sessionId: sessionIds[0] }),
  "registered sessions cannot be rebound to another user",
);

function placeWager(overrides = {}) {
  return createTxIntent({
    kind: "place-wager",
    sender: account.address,
    nonce,
    market: marketId,
    payload: {
      outcome: "yes",
      amountMist: amount,
    },
    ...overrides,
  });
}

function marketGrant(overrides = {}) {
  return {
    kind: "market",
    userId,
    txKind: "place-wager",
    marketId,
    maxAmountMist: amount,
    custodyCap: custodyCap({
      user: userId,
      scope: defineSigningCustodyScope({
        kind: "sign-market-tx",
        market: marketId,
        txKinds: ["place-wager"],
        maxAmountMist: amount,
      }),
    }),
    ...overrides,
  };
}

const intent = placeWager();
const accepted = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[0],
  intent,
  grant: marketGrant(),
  previewHash: previewHashForPrototype(intent),
});

assert(accepted.tag === "accepted", "valid market grant signs");
assert(auditEvents.length === 1, "accepted signing emits an audit event");
assert(
  accepted.auditEvent.rebuiltPtbHash === auditEvents[0].rebuiltPtbHash,
  "returned and emitted audit events agree",
);

const changedOutcome = placeWager({
  payload: {
    outcome: "no",
    amountMist: amount,
  },
});
const changedOutcomeAccepted = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[1],
  intent: changedOutcome,
  grant: marketGrant(),
  previewHash: previewHashForPrototype(changedOutcome),
});

assert(
  changedOutcomeAccepted.tag === "accepted",
  "changed outcome still signs under the same grant",
);
assert(
  changedOutcomeAccepted.auditEvent.rebuiltPtbHash !==
    accepted.auditEvent.rebuiltPtbHash,
  "full payload changes the rebuilt PTB hash",
);
assert(
  changedOutcomeAccepted.txDigest !== accepted.txDigest,
  "prototype tx digest changes with signed material",
);

const previewRejected = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[2],
  intent,
  grant: marketGrant(),
  previewHash: parsePreviewHash(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ),
});

assert(
  previewRejected.tag === "rejected" &&
    previewRejected.reason === "preview_hash_mismatch",
  "preview hash mismatches are rejected",
);

const wrongSenderIntent = placeWager({ sender: parseSuiAddress("0x3") });
const senderRejected = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[3],
  intent: wrongSenderIntent,
  grant: marketGrant(),
  previewHash: previewHashForPrototype(wrongSenderIntent),
});

assert(
  senderRejected.tag === "rejected" && senderRejected.reason === "sender_mismatch",
  "intent sender must match the custodial account address",
);

const capRejected = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[4],
  intent,
  grant: marketGrant({
    custodyCap: custodyCap({
      user: userId,
      scope: defineSigningCustodyScope({
        kind: "sign-account-tx",
        txKinds: ["create-market"],
      }),
    }),
  }),
  previewHash: previewHashForPrototype(intent),
});

assert(
  capRejected.tag === "rejected" && capRejected.reason === "out_of_scope",
  "grant custody cap scope is enforced",
);

const oversizedIntent = placeWager({
  payload: {
    outcome: "yes",
    amountMist: parseMistAmount(11n),
  },
});
const spendRejected = wallet.signPolicyGatedIntent({
  userId,
  sessionId: sessionIds[5],
  intent: oversizedIntent,
  grant: marketGrant(),
  previewHash: previewHashForPrototype(oversizedIntent),
});

assert(
  spendRejected.tag === "rejected" &&
    spendRejected.reason === "spend_cap_exceeded",
  "grant and cap spend ceilings are enforced",
);

const sessionRejected = wallet.signPolicyGatedIntent({
  userId,
  sessionId: parseSessionId("runtime-wallet-forged01"),
  intent,
  grant: marketGrant(),
  previewHash: previewHashForPrototype(intent),
});

assert(
  sessionRejected.tag === "rejected" &&
    sessionRejected.reason === "session_invalid",
  "unregistered sessions are rejected",
);
