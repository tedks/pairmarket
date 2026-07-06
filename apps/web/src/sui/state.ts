import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import {
  parseInviteId,
  parseMarketId,
  parseMistAmount,
  parsePositionId,
  parseSuiAddress,
  parseSuiObjectId,
  parseUnixMs,
  parseUserId,
  type MarketId,
  type MistAmount,
  type SuiAddress,
  type SuiObjectId,
  type WagerOutcome,
} from "@pairmarket/core";
import type {
  AppState,
  FriendRequest,
  Friendship,
  Market,
  MarketPhase,
  UserProfile,
  VisibilityScope,
} from "../types.ts";
import { pairmarketMoveConfig, SUI_COIN_TYPE } from "./config.ts";
import { loadLocalMarketMetadata } from "./metadata.ts";

type ChainState = {
  readonly state: AppState;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => void;
};

type OwnedChainObjects = {
  readonly invites: readonly ChainInvite[];
  readonly positions: readonly ChainPosition[];
  readonly friendRequests: readonly FriendRequest[];
};

type ChainMarketCreated = {
  readonly id: MarketId;
  readonly creator: SuiObjectId;
  readonly subjectA: SuiObjectId;
  readonly subjectB: SuiObjectId;
  readonly visibility: VisibilityScope;
  readonly createdAtMs: number;
};

type ChainProfile = {
  readonly id: SuiObjectId;
  readonly owner: SuiAddress;
  readonly handle: string;
};

type ChainInvite = {
  readonly id: string;
  readonly marketId: MarketId;
  readonly grantee: SuiObjectId;
  readonly maxStakeMist: MistAmount;
};

type ChainPosition = {
  readonly id: string;
  readonly marketId: MarketId;
  readonly owner: SuiObjectId;
  readonly outcome: WagerOutcome;
  readonly amountMist: MistAmount;
  readonly claimed: boolean;
};

export function useChainAppState(baseState: AppState): ChainState {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const config = useMemo(() => pairmarketMoveConfig(), []);
  const [state, setState] = useState(baseState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const moveConfig = config;
    if (account === null || moveConfig === undefined) {
      setState(baseState);
      setLoading(false);
      setError(undefined);
      return;
    }

    const abort = new AbortController();
    const packageId = moveConfig.packageId;
    const viewerAddress = parseSuiAddress(account.address);
    setLoading(true);
    setError(undefined);

    void (async () => {
      try {
        const [profiles, friendships, marketEvents, owned] = await Promise.all([
          fetchProfiles(),
          fetchFriendships(),
          fetchMarketEvents(),
          fetchOwnedObjects(),
        ]);
        const viewerProfile = profiles.find((p) =>
          sameAddress(p.owner, viewerAddress),
        );
        const viewer = viewerProfile
          ? parseUserId(viewerProfile.id)
          : parseUserId(viewerAddress);
        const markets = await fetchMarkets(
          marketEvents,
          owned,
          friendships,
          viewerProfile?.id,
        );
        if (abort.signal.aborted) return;

        const users = new Map(baseState.users);
        users.set(parseUserId(viewerAddress), profileForAddress(viewerAddress));
        for (const profile of profiles) {
          users.set(parseUserId(profile.id), profileForChainProfile(profile));
        }
        for (const market of markets.values()) {
          ensureProfile(users, market.creator);
          for (const subject of market.subjects)
            ensureProfile(users, subject.user);
          for (const invite of market.invites)
            ensureProfile(users, invite.invitee);
          for (const position of market.positions)
            ensureProfile(users, position.owner);
        }

        setState({
          ...baseState,
          viewer,
          users,
          friendships,
          friendRequests: owned.friendRequests,
          markets,
          nowMs: parseUnixMs(Date.now()),
        });
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setState(baseState);
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();

    async function fetchProfiles(): Promise<readonly ChainProfile[]> {
      const profileIds: SuiObjectId[] = [];
      let cursor:
        | NonNullable<Parameters<typeof client.queryEvents>[0]>["cursor"]
        | undefined;
      do {
        const events = await client.queryEvents({
          query: {
            MoveEventType: `${packageId}::market::ProfileCreated`,
          },
          cursor,
          order: "ascending",
          limit: 100,
          signal: abort.signal,
        });
        for (const event of events.data) {
          const id = idFromField(event.parsedJson, "profile_id");
          if (id !== undefined) profileIds.push(parseSuiObjectId(id));
        }
        cursor = events.nextCursor;
        if (!events.hasNextPage) break;
      } while (cursor !== null && cursor !== undefined);

      if (profileIds.length === 0) return [];
      const objectPages = await Promise.all(
        chunks([...new Set(profileIds)], 50).map((ids) =>
          client.multiGetObjects({
            ids,
            options: { showContent: true, showType: true },
            signal: abort.signal,
          }),
        ),
      );

      const profiles: ChainProfile[] = [];
      for (const object of objectPages.flat()) {
        const data = object.data;
        const fields = moveFields(data?.content);
        if (!data?.objectId || fields === undefined) continue;
        if (!data.type?.includes("::market::Profile")) continue;
        profiles.push({
          id: parseSuiObjectId(data.objectId),
          owner: parseSuiAddress(fieldString(fields, "owner")),
          handle: fieldBytesAsString(fields, "handle"),
        });
      }
      return profiles;
    }

    async function fetchFriendships(): Promise<readonly Friendship[]> {
      const friendships: Friendship[] = [];
      let cursor:
        | NonNullable<Parameters<typeof client.queryEvents>[0]>["cursor"]
        | undefined;
      do {
        const events = await client.queryEvents({
          query: {
            MoveEventType: `${packageId}::market::FriendshipAccepted`,
          },
          cursor,
          order: "ascending",
          limit: 100,
          signal: abort.signal,
        });
        for (const event of events.data) {
          const a = idFromField(event.parsedJson, "a");
          const b = idFromField(event.parsedJson, "b");
          if (a === undefined || b === undefined) continue;
          friendships.push({
            a: parseUserId(parseSuiObjectId(a)),
            b: parseUserId(parseSuiObjectId(b)),
          });
        }
        cursor = events.nextCursor;
        if (!events.hasNextPage) break;
      } while (cursor !== null && cursor !== undefined);
      return friendships;
    }

    async function fetchMarketEvents(): Promise<readonly ChainMarketCreated[]> {
      const created: ChainMarketCreated[] = [];
      let cursor:
        | NonNullable<Parameters<typeof client.queryEvents>[0]>["cursor"]
        | undefined;
      do {
        const events = await client.queryEvents({
          query: {
            MoveEventType: `${packageId}::market::MarketCreated`,
          },
          cursor,
          order: "ascending",
          limit: 100,
          signal: abort.signal,
        });
        for (const event of events.data) {
          const id = idFromField(event.parsedJson, "market_id");
          if (id === undefined) continue;
          const creator = idFromField(event.parsedJson, "creator");
          const subjectA = idFromField(event.parsedJson, "subject_a");
          const subjectB = idFromField(event.parsedJson, "subject_b");
          if (
            creator === undefined ||
            subjectA === undefined ||
            subjectB === undefined
          ) {
            continue;
          }
          created.push({
            id: parseMarketId(id),
            creator: parseSuiObjectId(creator),
            subjectA: parseSuiObjectId(subjectA),
            subjectB: parseSuiObjectId(subjectB),
            visibility: visibilityFromCode(
              fieldNumber(
                event.parsedJson as Record<string, unknown>,
                "visibility",
              ),
            ),
            createdAtMs:
              event.timestampMs === null || event.timestampMs === undefined
                ? Date.now()
                : Number(event.timestampMs),
          });
        }
        cursor = events.nextCursor;
        if (!events.hasNextPage) break;
      } while (cursor !== null && cursor !== undefined);
      return created;
    }

    async function fetchOwnedObjects(): Promise<OwnedChainObjects> {
      const invites: ChainInvite[] = [];
      const positions: ChainPosition[] = [];
      const friendRequests: FriendRequest[] = [];
      let cursor: string | null | undefined;

      do {
        const response = await client.getOwnedObjects({
          owner: viewerAddress,
          cursor,
          filter: {
            MoveModule: { package: packageId, module: "market" },
          },
          options: { showContent: true, showType: true },
          limit: 100,
          signal: abort.signal,
        });
        for (const object of response.data) {
          const data = object.data;
          const fields = moveFields(data?.content);
          if (!data?.type || fields === undefined) continue;

          if (data.type.includes("::market::InviteTicket")) {
            invites.push({
              id: data.objectId,
              marketId: parseMarketId(idFromField(fields, "market_id")),
              grantee: parseSuiObjectId(idFromField(fields, "grantee")),
              maxStakeMist: parseMistAmount(fieldBigInt(fields, "max_stake")),
            });
          } else if (data.type.includes("::market::FriendRequest")) {
            friendRequests.push({
              id: parseSuiObjectId(data.objectId),
              requester: parseUserId(
                parseSuiObjectId(idFromField(fields, "requester")),
              ),
              target: parseUserId(
                parseSuiObjectId(idFromField(fields, "target")),
              ),
            });
          } else if (
            data.type.includes("::market::Position") &&
            data.type.includes(SUI_COIN_TYPE)
          ) {
            positions.push({
              id: data.objectId,
              marketId: parseMarketId(idFromField(fields, "market_id")),
              owner: parseSuiObjectId(idFromField(fields, "owner")),
              outcome: outcomeFromCode(fieldNumber(fields, "outcome")),
              amountMist: parseMistAmount(fieldBigInt(fields, "stake")),
              claimed: fieldBoolean(fields, "claimed"),
            });
          }
        }
        cursor = response.nextCursor;
        if (!response.hasNextPage) break;
      } while (cursor !== null && cursor !== undefined);

      return { invites, positions, friendRequests };
    }

    async function fetchMarkets(
      marketEvents: readonly ChainMarketCreated[],
      owned: OwnedChainObjects,
      friendships: readonly Friendship[],
      viewerProfileId: SuiObjectId | undefined,
    ): Promise<ReadonlyMap<MarketId, Market>> {
      const marketIds = marketEvents.map((event) => event.id);
      if (marketIds.length === 0) return new Map();
      const marketCreatedAtMs = new Map(
        marketEvents.map((event) => [event.id, event.createdAtMs] as const),
      );
      const marketEventById = new Map(
        marketEvents.map((event) => [event.id, event] as const),
      );
      const objectPages = await Promise.all(
        chunks([...new Set(marketIds)], 50).map((ids) =>
          client.multiGetObjects({
            ids,
            options: { showContent: true, showType: true },
            signal: abort.signal,
          }),
        ),
      );
      const objects = objectPages.flat();
      const markets = new Map<MarketId, Market>();

      for (const object of objects) {
        const data = object.data;
        const fields = moveFields(data?.content);
        if (!data?.objectId || fields === undefined) continue;
        if (!data.type?.includes("::market::Market")) continue;

        const marketId = parseMarketId(data.objectId);
        const creator = parseSuiObjectId(idFromField(fields, "creator"));
        const subjectA = parseSuiObjectId(idFromField(fields, "subject_a"));
        const subjectB = parseSuiObjectId(idFromField(fields, "subject_b"));
        const visibility =
          marketEventById.get(marketId)?.visibility ?? "friends";
        const viewerVisible = isMarketVisible({
          marketId,
          creator,
          subjectA,
          subjectB,
          visibility,
          viewerProfileId,
          owned,
          friendships,
        });

        if (!viewerVisible) continue;

        const positions = owned.positions
          .filter((position) => position.marketId === marketId)
          .map((position) => ({
            id: parsePositionId(position.id),
            market: marketId,
            owner: parseUserId(position.owner),
            outcome: position.outcome,
            amountMist: position.amountMist,
            claimed: position.claimed,
          }));
        const invites = owned.invites
          .filter((invite) => invite.marketId === marketId)
          .map((invite) => ({
            id: parseInviteId(invite.id),
            market: marketId,
            invitee: parseUserId(invite.grantee),
            maxStakeMist: invite.maxStakeMist,
            accepted: true,
          }));
        const metadata = loadLocalMarketMetadata(packageId, marketId);
        const stateCode = fieldNumber(fields, "state");
        const winningOutcome = outcomeFromOptionalCode(
          fieldNumber(fields, "winning_outcome"),
        );

        markets.set(marketId, {
          id: marketId,
          creator: parseUserId(creator),
          subjects: [
            {
              role: "subject-a",
              user: parseUserId(subjectA),
              consent: fieldBoolean(fields, "consent_a")
                ? { status: "accepted", atMs: parseUnixMs(Date.now()) }
                : { status: "pending" },
            },
            {
              role: "subject-b",
              user: parseUserId(subjectB),
              consent: fieldBoolean(fields, "consent_b")
                ? { status: "accepted", atMs: parseUnixMs(Date.now()) }
                : { status: "pending" },
            },
          ],
          visibility,
          operationalization: metadata.operationalization,
          closeMs: parseUnixMs(fieldNumber(fields, "close_ms")),
          resolutionDeadlineMs: parseUnixMs(
            fieldNumber(fields, "resolution_deadline_ms"),
          ),
          challengeWindowMs: fieldNumber(fields, "challenge_window_ms"),
          content: metadata,
          phase: phaseFromCode(stateCode),
          yesPoolMist: parseMistAmount(balanceValue(fields, "yes_pool")),
          noPoolMist: parseMistAmount(balanceValue(fields, "no_pool")),
          payoutPoolMist: parseMistAmount(balanceValue(fields, "payout_pool")),
          yesSharesMist: parseMistAmount(fieldBigInt(fields, "yes_shares")),
          noSharesMist: parseMistAmount(fieldBigInt(fields, "no_shares")),
          invites,
          positions,
          attestations: attestationsFromFields(fields, subjectA, subjectB),
          createdAtMs: parseUnixMs(marketCreatedAtMs.get(marketId) ?? 0),
          ...(winningOutcome === undefined
            ? {}
            : { settledOutcome: winningOutcome }),
        });
      }

      return markets;
    }
  }, [account, baseState, client, config, refreshNonce]);

  return { state, loading, error, refresh };
}

function moveFields(content: unknown): Record<string, unknown> | undefined {
  if (
    content !== null &&
    typeof content === "object" &&
    (content as { dataType?: unknown }).dataType === "moveObject"
  ) {
    const fields = (content as { fields?: unknown }).fields;
    if (fields !== null && typeof fields === "object") {
      return fields as Record<string, unknown>;
    }
  }
  return undefined;
}

function profileForAddress(address: SuiAddress): UserProfile {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return {
    id: parseUserId(address),
    handle: short,
    displayName: short,
    address,
  };
}

function profileForChainProfile(profile: ChainProfile): UserProfile {
  return {
    id: parseUserId(profile.id),
    handle: profile.handle,
    displayName: `@${profile.handle}`,
    profileObjectId: profile.id,
    address: profile.owner,
  };
}

function ensureProfile(
  users: Map<UserProfile["id"], UserProfile>,
  id: UserProfile["id"],
): void {
  if (users.has(id)) return;
  users.set(id, {
    id,
    handle: id,
    displayName: id,
    address: parseSuiAddress("0x1"),
  });
}

function sameAddress(a: SuiAddress, b: SuiAddress): boolean {
  return parseSuiAddress(a) === parseSuiAddress(b);
}

function fieldString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value === "string") return value;
  const id = idFromField(fields, key);
  if (id !== undefined) return id;
  throw new Error(`Missing string field: ${key}`);
}

function fieldBytesAsString(
  fields: Record<string, unknown>,
  key: string,
): string {
  const value = fields[key];
  if (Array.isArray(value)) {
    const bytes = value.map((b) =>
      typeof b === "number" ? b : typeof b === "string" ? Number(b) : NaN,
    );
    if (bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  }
  if (typeof value === "string") return value;
  throw new Error(`Missing byte vector field: ${key}`);
}

function fieldBoolean(fields: Record<string, unknown>, key: string): boolean {
  const value = fields[key];
  if (typeof value === "boolean") return value;
  throw new Error(`Missing boolean field: ${key}`);
}

function fieldNumber(fields: Record<string, unknown>, key: string): number {
  const value = fields[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Missing numeric field: ${key}`);
}

function fieldBigInt(fields: Record<string, unknown>, key: string): bigint {
  const value = fields[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value !== null && typeof value === "object") {
    const nested = (value as { fields?: { value?: unknown } }).fields?.value;
    if (typeof nested === "string") return BigInt(nested);
    if (typeof nested === "number") return BigInt(nested);
  }
  throw new Error(`Missing bigint field: ${key}`);
}

function balanceValue(fields: Record<string, unknown>, key: string): bigint {
  const value = fields[key];
  if (value !== null && typeof value === "object") {
    return fieldBigInt(value as Record<string, unknown>, "value");
  }
  return fieldBigInt(fields, key);
}

function idFromField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const direct = (value as Record<string, unknown>)[key];
  if (typeof direct === "string") return direct;
  if (
    direct !== null &&
    typeof direct === "object" &&
    typeof (direct as Record<string, unknown>).id === "string"
  ) {
    return (direct as { id: string }).id;
  }
  return undefined;
}

function phaseFromCode(code: number): MarketPhase {
  switch (code) {
    case 0:
      return "proposed";
    case 1:
      return "trading";
    case 2:
      return "locked";
    case 3:
      return "attestation-pending";
    case 4:
    case 5:
      return "challenge-window-open";
    case 6:
      return "settled";
    case 7:
      return "cancelled";
    case 8:
      return "expired";
    default:
      return "expired";
  }
}

function outcomeFromCode(code: number): WagerOutcome {
  if (code === 1) return "yes";
  if (code === 2) return "no";
  throw new Error(`Unsupported wager outcome code: ${code}`);
}

function outcomeFromOptionalCode(
  code: number,
): "yes" | "no" | "invalid" | undefined {
  if (code === 1) return "yes";
  if (code === 2) return "no";
  if (code === 3) return "invalid";
  return undefined;
}

function visibilityFromCode(code: number): VisibilityScope {
  if (code === 0) return "friends";
  if (code === 1) return "friends-of-friends";
  if (code === 2) return "public";
  return "friends";
}

function isMarketVisible({
  marketId,
  creator,
  subjectA,
  subjectB,
  visibility,
  viewerProfileId,
  owned,
  friendships,
}: {
  readonly marketId: MarketId;
  readonly creator: SuiObjectId;
  readonly subjectA: SuiObjectId;
  readonly subjectB: SuiObjectId;
  readonly visibility: VisibilityScope;
  readonly viewerProfileId: SuiObjectId | undefined;
  readonly owned: OwnedChainObjects;
  readonly friendships: readonly Friendship[];
}): boolean {
  const viewer =
    viewerProfileId === undefined ? undefined : parseUserId(viewerProfileId);
  const isSubject =
    viewer !== undefined &&
    (viewer === parseUserId(subjectA) || viewer === parseUserId(subjectB));
  if (isSubject) return false;
  if (viewer !== undefined && viewer === parseUserId(creator)) return true;
  if (
    viewer !== undefined &&
    (owned.invites.some(
      (invite) =>
        invite.marketId === marketId && parseUserId(invite.grantee) === viewer,
    ) ||
      owned.positions.some(
        (position) =>
          position.marketId === marketId &&
          parseUserId(position.owner) === viewer,
      ))
  ) {
    return true;
  }
  if (visibility === "public") return true;
  if (viewer === undefined) return false;

  const creatorUser = parseUserId(creator);
  if (areFriends(friendships, creatorUser, viewer)) return true;
  return (
    visibility === "friends-of-friends" &&
    mutualFriendCount(friendships, creatorUser, viewer) > 0
  );
}

function areFriends(
  friendships: readonly Friendship[],
  a: UserProfile["id"],
  b: UserProfile["id"],
): boolean {
  return friendships.some(
    (f) => (f.a === a && f.b === b) || (f.a === b && f.b === a),
  );
}

function mutualFriendCount(
  friendships: readonly Friendship[],
  a: UserProfile["id"],
  b: UserProfile["id"],
): number {
  const aFriends = friendsOf(friendships, a);
  const bFriends = friendsOf(friendships, b);
  let count = 0;
  for (const friend of aFriends) {
    if (bFriends.has(friend)) count += 1;
  }
  return count;
}

function friendsOf(
  friendships: readonly Friendship[],
  profile: UserProfile["id"],
): ReadonlySet<UserProfile["id"]> {
  const friends = new Set<UserProfile["id"]>();
  for (const friendship of friendships) {
    if (friendship.a === profile) friends.add(friendship.b);
    if (friendship.b === profile) friends.add(friendship.a);
  }
  return friends;
}

function attestationsFromFields(
  fields: Record<string, unknown>,
  subjectA: SuiObjectId,
  subjectB: SuiObjectId,
): Market["attestations"] {
  const now = parseUnixMs(Date.now());
  return [
    { subject: subjectA, outcome: fieldNumber(fields, "last_attestation_a") },
    { subject: subjectB, outcome: fieldNumber(fields, "last_attestation_b") },
  ]
    .map(({ subject, outcome }) => {
      const parsed = outcomeFromOptionalCode(outcome);
      return parsed === undefined
        ? undefined
        : { attestor: parseUserId(subject), outcome: parsed, atMs: now };
    })
    .filter((a): a is Market["attestations"][number] => a !== undefined);
}

function chunks<T>(items: readonly T[], size: number): readonly T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}
