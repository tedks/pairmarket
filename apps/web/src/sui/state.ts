import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import {
  parseInviteId,
  parseMarketId,
  parseMistAmount,
  parsePositionId,
  parseSuiAddress,
  parseUnixMs,
  parseUserId,
  type MarketId,
  type MistAmount,
  type SuiAddress,
  type WagerOutcome,
} from "@pairmarket/core";
import type { AppState, Market, MarketPhase, UserProfile } from "../types.ts";
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
};

type ChainMarketCreated = {
  readonly id: MarketId;
  readonly createdAtMs: number;
};

type ChainInvite = {
  readonly id: string;
  readonly marketId: MarketId;
  readonly grantee: SuiAddress;
  readonly maxStakeMist: MistAmount;
};

type ChainPosition = {
  readonly id: string;
  readonly marketId: MarketId;
  readonly owner: SuiAddress;
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
        const [marketEvents, owned] = await Promise.all([
          fetchMarketEvents(),
          fetchOwnedObjects(),
        ]);
        const markets = await fetchMarkets(marketEvents, owned);
        if (abort.signal.aborted) return;

        const users = new Map(baseState.users);
        users.set(parseUserId(viewerAddress), profileForAddress(viewerAddress));
        for (const market of markets.values()) {
          users.set(
            market.creator,
            profileForAddress(parseSuiAddress(market.creator)),
          );
          for (const subject of market.subjects) {
            users.set(
              subject.user,
              profileForAddress(parseSuiAddress(subject.user)),
            );
          }
          for (const invite of market.invites) {
            users.set(
              invite.invitee,
              profileForAddress(parseSuiAddress(invite.invitee)),
            );
          }
          for (const position of market.positions) {
            users.set(
              position.owner,
              profileForAddress(parseSuiAddress(position.owner)),
            );
          }
        }

        setState({
          ...baseState,
          viewer: parseUserId(viewerAddress),
          users,
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
          created.push({
            id: parseMarketId(id),
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
              grantee: parseSuiAddress(fieldString(fields, "grantee")),
              maxStakeMist: parseMistAmount(fieldBigInt(fields, "max_stake")),
            });
          } else if (
            data.type.includes("::market::Position") &&
            data.type.includes(SUI_COIN_TYPE)
          ) {
            positions.push({
              id: data.objectId,
              marketId: parseMarketId(idFromField(fields, "market_id")),
              owner: parseSuiAddress(fieldString(fields, "owner")),
              outcome: outcomeFromCode(fieldNumber(fields, "outcome")),
              amountMist: parseMistAmount(fieldBigInt(fields, "stake")),
              claimed: fieldBoolean(fields, "claimed"),
            });
          }
        }
        cursor = response.nextCursor;
        if (!response.hasNextPage) break;
      } while (cursor !== null && cursor !== undefined);

      return { invites, positions };
    }

    async function fetchMarkets(
      marketEvents: readonly ChainMarketCreated[],
      owned: OwnedChainObjects,
    ): Promise<ReadonlyMap<MarketId, Market>> {
      const marketIds = marketEvents.map((event) => event.id);
      if (marketIds.length === 0) return new Map();
      const marketCreatedAtMs = new Map(
        marketEvents.map((event) => [event.id, event.createdAtMs] as const),
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
        const creator = parseSuiAddress(fieldString(fields, "creator"));
        const subjectA = parseSuiAddress(fieldString(fields, "subject_a"));
        const subjectB = parseSuiAddress(fieldString(fields, "subject_b"));
        const viewerVisible =
          sameAddress(creator, viewerAddress) ||
          sameAddress(subjectA, viewerAddress) ||
          sameAddress(subjectB, viewerAddress) ||
          owned.invites.some((invite) => invite.marketId === marketId) ||
          owned.positions.some((position) => position.marketId === marketId);

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

function attestationsFromFields(
  fields: Record<string, unknown>,
  subjectA: SuiAddress,
  subjectB: SuiAddress,
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
