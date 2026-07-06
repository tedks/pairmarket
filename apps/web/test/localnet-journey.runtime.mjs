import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  buildClaimTransaction,
  buildConsentTransaction,
  buildCreateMarketTransaction,
  buildFinalizeTransaction,
  buildMintInviteTransaction,
  buildPlaceTransaction,
  buildSubmitAttestationTransaction,
  findCreatedMarketId,
} from "../src/sui/market.ts";
import {
  buildAcceptFriendshipTransaction,
  buildCreateProfileTransaction,
  buildRequestFriendshipTransaction,
  findCreatedProfileId,
} from "../src/sui/social.ts";
import { SUI_CLOCK_OBJECT_ID, SUI_COIN_TYPE } from "../src/sui/config.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../..");
const env = loadLocalEnv(resolve(root, ".devstack/pairmarket-local.env"));
const packageId = requiredEnv("PAIRMARKET_MOVE_PACKAGE_ID");
const configId = requiredEnv("PAIRMARKET_MOVE_CONFIG_ID");
const rpcUrl = requiredEnv("PAIRMARKET_SUI_RPC_URL");
const faucetUrl = requiredEnv("PAIRMARKET_SUI_FAUCET_URL");
const faucetHost = new URL(faucetUrl).origin;
const moveConfig = { packageId, configId };
const client = new SuiJsonRpcClient({ network: "localnet", url: rpcUrl });

const creator = new Ed25519Keypair();
const subjectA = new Ed25519Keypair();
const subjectB = new Ed25519Keypair();
const invitee = new Ed25519Keypair();

await Promise.all([creator, subjectA, subjectB, invitee].map(fund));

const creatorProfile = await createProfile("creator", creator);
const subjectAProfile = await createProfile("heyellieday", subjectA);
const subjectBProfile = await createProfile("tedks", subjectB);
const inviteeProfile = await createProfile("paula", invitee);
await befriend(creator, creatorProfile, subjectA, subjectAProfile);
await befriend(creator, creatorProfile, subjectB, subjectBProfile);
await befriend(creator, creatorProfile, invitee, inviteeProfile);

const now = Date.now();
const closeMs = now + 15_000;
const earliestAttestMs = closeMs + 1_000;
const resolutionDeadlineMs = earliestAttestMs + 20_000;
const challengeWindowMs = 1_000;
const disputeDeadlineMs = resolutionDeadlineMs + 2_000;

const created = await execute(
  await buildCreateMarketTransaction({
    config: moveConfig,
    creatorProfile,
    operationalization: { kind: "lasts-n-dates", n: 3 },
    visibility: "friends",
    title: "Localnet generated-wallet journey",
    prompt: "Does this real on-chain journey settle?",
    subjectAProfile,
    subjectBProfile,
    closeMs,
    earliestAttestMs,
    resolutionDeadlineMs,
    challengeWindowMs,
    disputeDeadlineMs,
    feeBps: 0,
    resolverCommittee: [creatorProfile],
  }),
  creator,
);
const marketId = findCreatedMarketId(created);
assert.ok(marketId, "create_market emitted a market id");

await execute(
  buildConsentTransaction(moveConfig, marketId, subjectAProfile),
  subjectA,
);
await execute(
  buildConsentTransaction(moveConfig, marketId, subjectBProfile),
  subjectB,
);

await execute(
  buildMintInviteTransaction(
    moveConfig,
    marketId,
    creatorProfile,
    inviteeProfile,
    1_000_000_000n,
    closeMs,
  ),
  creator,
);

const inviteId = await findOwnedObject(
  addressOf(invitee),
  `${packageId}::market::InviteTicket`,
);
assert.ok(inviteId, "invitee owns a real InviteTicket object");

await execute(
  buildPlaceTransaction(
    moveConfig,
    marketId,
    inviteId,
    inviteeProfile,
    "yes",
    100_000_000n,
  ),
  invitee,
);

const positionId = await findOwnedObject(
  addressOf(invitee),
  `${packageId}::market::Position<${SUI_COIN_TYPE}>`,
);
assert.ok(positionId, "invitee owns a real Position object");

await sleepUntilChainClock(earliestAttestMs + 300);
await execute(
  buildSubmitAttestationTransaction(
    moveConfig,
    marketId,
    subjectAProfile,
    "yes",
  ),
  subjectA,
);
await execute(
  buildSubmitAttestationTransaction(
    moveConfig,
    marketId,
    subjectBProfile,
    "yes",
  ),
  subjectB,
);

await sleepUntilChainClock((await chainClockMs()) + challengeWindowMs + 300);
await execute(buildFinalizeTransaction(moveConfig, marketId), creator);
await execute(
  buildClaimTransaction(moveConfig, marketId, positionId, inviteeProfile),
  invitee,
);

const market = await client.core.getObject({
  objectId: marketId,
  include: { json: true },
});
assert.equal(fieldNumber(market.object.json, "state"), 6, "market is settled");
assert.equal(
  fieldNumber(market.object.json, "winning_outcome"),
  1,
  "YES outcome won",
);

function loadLocalEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1
          ? undefined
          : [line.slice(0, index), line.slice(index + 1)];
      })
      .filter(Boolean),
  );
}

function requiredEnv(key) {
  const value = process.env[key] ?? env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `${key} is required. Run nix develop --command pnpm devstack:up && pnpm devstack:deploy first.`,
    );
  }
  return value;
}

async function fund(keypair) {
  const recipient = addressOf(keypair);
  const response = await requestSuiFromFaucetV2({
    host: faucetHost,
    recipient,
  });
  const digests = (response.coins_sent ?? []).map(
    (coin) => coin.transferTxDigest,
  );
  await Promise.all(
    digests.map((digest) =>
      client.core.waitForTransaction({
        digest,
        timeout: 30_000,
      }),
    ),
  );
}

async function createProfile(handle, signer) {
  const result = await execute(
    buildCreateProfileTransaction(moveConfig, handle),
    signer,
  );
  const profileId = findCreatedProfileId(result);
  assert.ok(profileId, `create_profile emitted a profile id for ${handle}`);
  return profileId;
}

async function befriend(requester, requesterProfile, target, targetProfile) {
  await execute(
    buildRequestFriendshipTransaction(
      moveConfig,
      requesterProfile,
      targetProfile,
    ),
    requester,
  );
  const requestId = await findOwnedObject(
    addressOf(target),
    `${packageId}::market::FriendRequest`,
  );
  assert.ok(requestId, "target owns a real FriendRequest object");
  await execute(
    buildAcceptFriendshipTransaction(
      moveConfig,
      requestId,
      targetProfile,
      requesterProfile,
    ),
    target,
  );
}

async function execute(transaction, signer) {
  transaction.setSender(addressOf(signer));
  transaction.setExpiration({ None: true });
  const result = await client.core.signAndExecuteTransaction({
    transaction,
    signer,
    include: {
      effects: true,
      events: true,
      objectTypes: true,
    },
  });

  if (result.FailedTransaction) {
    throw new Error(
      result.FailedTransaction.status.error?.message ??
        "Sui transaction failed",
    );
  }

  return client.core.waitForTransaction({
    result,
    include: {
      effects: true,
      events: true,
      objectTypes: true,
    },
    timeout: 30_000,
  });
}

async function findOwnedObject(owner, type) {
  const response = await client.core.listOwnedObjects({
    owner,
    type,
    include: { json: true },
    limit: 50,
  });
  return response.objects[0]?.objectId;
}

function addressOf(keypair) {
  return keypair.getPublicKey().toSuiAddress();
}

function fieldNumber(fields, key) {
  assert.ok(fields, `object JSON exists for ${key}`);
  const value = fields[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  throw new Error(`Missing numeric field ${key}`);
}

async function sleepUntilChainClock(targetMs) {
  while ((await chainClockMs()) < targetMs) {
    await sleep(250);
  }
}

async function chainClockMs() {
  const clock = await client.core.getObject({
    objectId: SUI_CLOCK_OBJECT_ID,
    include: { json: true },
  });
  return fieldNumber(clock.object.json, "timestamp_ms");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
