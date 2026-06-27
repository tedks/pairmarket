import { parseMistAmount, parseUnixMs } from "@pairmarket/core";
import { createMarketDraft } from "../src/mock/intents.ts";
import { seedAppState } from "../src/mock/seed.ts";

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

const state = seedAppState();
const users = [...state.users.values()];
const [subjectA, subjectB, invitee] = users.filter((u) => u.id !== state.viewer);

assert(subjectA, "seed has first non-viewer subject");
assert(subjectB, "seed has second non-viewer subject");
assert(invitee, "seed has invitee");

const nowMs = state.nowMs;
const resolutionDeadlineMs = parseUnixMs(nowMs + 7 * 86_400_000);
const laterOperationalizationDeadlineMs = parseUnixMs(nowMs + 8 * 86_400_000);

assertThrows(
  () =>
    createMarketDraft(state, {
      title: "Impossible market",
      prompt: "The operationalization deadline is after resolution.",
      subjectA: subjectA.id,
      subjectB: subjectB.id,
      operationalization: {
        kind: "meet-by-date",
        deadlineMs: laterOperationalizationDeadlineMs,
      },
      resolutionDeadlineMs,
      challengeWindowMs: 2 * 86_400_000,
      invitees: [
        {
          invitee: invitee.id,
          maxStakeMist: parseMistAmount(1_000_000_000n),
        },
      ],
    }),
  "date-based operationalization deadline cannot be after resolution deadline",
);

const dateBased = createMarketDraft(state, {
  title: "Possible date-based market",
  prompt: "Meeting by a date can resolve at that same deadline.",
  subjectA: subjectA.id,
  subjectB: subjectB.id,
  operationalization: {
    kind: "meet-by-date",
    deadlineMs: resolutionDeadlineMs,
  },
  resolutionDeadlineMs,
  challengeWindowMs: 2 * 86_400_000,
  invitees: [
    {
      invitee: invitee.id,
      maxStakeMist: parseMistAmount(1_000_000_000n),
    },
  ],
});

assert(
  dateBased.markets.size === state.markets.size + 1,
  "date-based operationalization may share the resolution deadline",
);

const next = createMarketDraft(state, {
  title: "Possible market",
  prompt: "Lasting N dates resolves by the market deadline.",
  subjectA: subjectA.id,
  subjectB: subjectB.id,
  operationalization: { kind: "lasts-n-dates", n: 3 },
  resolutionDeadlineMs,
  challengeWindowMs: 2 * 86_400_000,
  invitees: [
    {
      invitee: invitee.id,
      maxStakeMist: parseMistAmount(1_000_000_000n),
    },
  ],
});

assert(
  next.markets.size === state.markets.size + 1,
  "lasts-n-dates markets do not require an operationalization deadline",
);
