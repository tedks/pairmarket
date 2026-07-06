import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Transaction } from "@mysten/sui/transactions";
import type { MarketId, WagerOutcome } from "@pairmarket/core";
import { parseMistAmount, tryParseSuiAddress } from "@pairmarket/core";
import type { Route } from "../App.tsx";
import type { AppState, Market, Subject } from "../types.ts";
import {
  formatMarketId,
  formatSui,
  operationalizationLabel,
  phaseLabel,
  formatDuration,
} from "../format.ts";
import {
  payoutPool,
  sharesByOutcome,
  viewerIsMember,
} from "../market-selectors.ts";
import {
  pairmarketMoveConfig,
  type PairmarketMoveConfig,
} from "../sui/config.ts";
import {
  buildClaimTransaction,
  buildConsentTransaction,
  buildFinalizeTransaction,
  buildMintInviteTransaction,
  buildPlaceTransaction,
  buildRefundTransaction,
  buildSubmitAttestationTransaction,
} from "../sui/market.ts";
import { useExecuteSuiTransaction } from "../sui/execute.ts";

// Suggested wager amount; clamped down to the viewer's remaining invite cap.
const DEFAULT_WAGER_MIST = 500_000_000n;

type Props = {
  readonly state: AppState;
  readonly marketId: MarketId;
  readonly setRoute: (r: Route) => void;
  readonly refresh: () => void;
};

type RunMarketTx = (transaction: Transaction) => void;

export function MarketDetail({
  state,
  marketId,
  setRoute,
  refresh,
}: Props): JSX.Element {
  const config = pairmarketMoveConfig();
  const execute = useExecuteSuiTransaction();
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const runMarketTx: RunMarketTx = (transaction) => {
    setActionError(undefined);
    void (async () => {
      try {
        await execute(transaction);
        refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    })();
  };
  const market = state.markets.get(marketId);
  if (!market) {
    return (
      <section className="market-detail">
        <p>Market not found.</p>
        <button onClick={() => setRoute({ kind: "markets", filter: "all" })}>
          Back
        </button>
      </section>
    );
  }
  const isMember = viewerIsMember(state, market);

  if (!isMember) {
    return (
      <section className="market-detail" data-testid="market-detail">
        <header className="market-detail-head">
          <button
            type="button"
            className="back-link"
            onClick={() => setRoute({ kind: "markets", filter: "all" })}
          >
            ← Markets
          </button>
        </header>
        <h1 className="market-detail-title market-detail-title-redacted">
          [encrypted · not a policy member]
        </h1>
        <div className="market-detail-grid">
          <Card title="Private market">
            <p className="card-empty">
              This market is private by invitation. Details remain encrypted for
              viewers outside the policy.
            </p>
          </Card>
        </div>
      </section>
    );
  }

  return (
    <section className="market-detail" data-testid="market-detail">
      <header className="market-detail-head">
        <button
          type="button"
          className="back-link"
          onClick={() => setRoute({ kind: "markets", filter: "all" })}
        >
          ← Markets
        </button>
        <span className={`phase-chip phase-${market.phase}`}>
          {phaseLabel(market.phase)}
        </span>
      </header>

      <h1 className="market-detail-title">{market.content.title}</h1>
      <p className="market-detail-sub">
        {formatMarketId(market.id)} · created{" "}
        {formatDuration(state.nowMs, market.createdAtMs)} · deadline{" "}
        {formatDuration(state.nowMs, market.resolutionDeadlineMs)}
      </p>
      {actionError ? <p className="form-error">{actionError}</p> : null}

      <div className="market-detail-grid">
        <Card title="Terms">
          <KeyVal
            k="Operationalization"
            v={operationalizationLabel(market.operationalization)}
          />
          <KeyVal
            k="Resolution deadline"
            v={formatDuration(state.nowMs, market.resolutionDeadlineMs)}
          />
          <KeyVal
            k="Challenge window"
            v={`${Math.round(market.challengeWindowMs / 3_600_000)}h`}
          />
          <KeyVal k="Prompt" v={market.content.prompt} multiline />
        </Card>

        <SubjectsCard
          market={market}
          state={state}
          config={config}
          runMarketTx={runMarketTx}
        />

        <Card title="Pool">
          <KeyVal k="Total escrowed" v={formatSui(payoutPool(market))} />
          <KeyVal k="YES" v={formatSui(sharesByOutcome(market, "yes"))} />
          <KeyVal k="NO" v={formatSui(sharesByOutcome(market, "no"))} />
          {market.settledOutcome ? (
            <KeyVal
              k="Settled outcome"
              v={market.settledOutcome.toUpperCase()}
            />
          ) : null}
        </Card>

        <InvitesCard
          market={market}
          state={state}
          config={config}
          runMarketTx={runMarketTx}
        />
        <PositionsCard
          market={market}
          state={state}
          config={config}
          runMarketTx={runMarketTx}
        />
        <ActionsCard
          market={market}
          state={state}
          config={config}
          runMarketTx={runMarketTx}
        />
        <AttestationCard
          market={market}
          state={state}
          config={config}
          runMarketTx={runMarketTx}
        />
      </div>
    </section>
  );
}

function Card({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      <div className="card-body">{children}</div>
    </section>
  );
}

function KeyVal({
  k,
  v,
  multiline,
}: {
  readonly k: string;
  readonly v: string;
  readonly multiline?: boolean;
}): JSX.Element {
  return (
    <div className={multiline ? "kv kv-multiline" : "kv"}>
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

function SubjectsCard({
  market,
  state,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  return (
    <Card title="Subjects">
      {market.subjects.map((s) => (
        <SubjectRow
          key={s.role}
          state={state}
          market={market}
          subject={s}
          config={config}
          runMarketTx={runMarketTx}
        />
      ))}
    </Card>
  );
}

function SubjectRow({
  state,
  market,
  subject,
  config,
  runMarketTx,
}: {
  readonly state: AppState;
  readonly market: Market;
  readonly subject: Subject;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  const profile = state.users.get(subject.user);
  const isMe = subject.user === state.viewer;
  return (
    <div className="subject-row" data-testid={`subject-${subject.role}`}>
      <div className="subject-id">
        <span className="subject-role">
          {subject.role === "subject-a" ? "A" : "B"}
        </span>
        <span className="subject-name">
          {profile?.displayName ?? subject.user}
        </span>
        {isMe ? <span className="me-tag">you</span> : null}
      </div>
      <div className="subject-consent">
        <ConsentChip subject={subject} />
        {isMe && subject.consent.status === "pending" ? (
          <div className="subject-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="consent-accept"
              disabled={config === undefined}
              onClick={() => {
                if (config !== undefined) {
                  runMarketTx(buildConsentTransaction(config, market.id));
                }
              }}
            >
              Accept
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConsentChip({ subject }: { readonly subject: Subject }): JSX.Element {
  const s = subject.consent.status;
  return <span className={`consent-chip consent-${s}`}>{s}</span>;
}

function InvitesCard({
  market,
  state,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  const viewerInvite = market.invites.find((i) => i.invitee === state.viewer);
  const viewerIsCreator = market.creator === state.viewer;
  return (
    <Card title="Invites">
      {market.invites.length === 0 ? (
        <p className="card-empty">No invites yet.</p>
      ) : (
        <ul className="invite-list">
          {market.invites.map((inv) => {
            const profile = state.users.get(inv.invitee);
            return (
              <li key={inv.id} className="invite-row" data-invite-id={inv.id}>
                <span>{profile?.displayName ?? inv.invitee}</span>
                <span className="invite-cap">
                  cap {formatSui(inv.maxStakeMist)}
                </span>
                <span
                  className={
                    inv.accepted
                      ? "invite-status accepted"
                      : "invite-status pending"
                  }
                >
                  {inv.accepted ? "accepted" : "pending"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {viewerInvite ? (
        <p className="card-empty">
          You hold an invite ticket with cap{" "}
          {formatSui(viewerInvite.maxStakeMist)}.
        </p>
      ) : null}
      {viewerIsCreator && market.phase === "trading" ? (
        <MintInviteForm
          market={market}
          config={config}
          runMarketTx={runMarketTx}
        />
      ) : null}
    </Card>
  );
}

function MintInviteForm({
  market,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  const [grantee, setGrantee] = useState("");
  const [capSui, setCapSui] = useState("1");
  const parsedGrantee = tryParseSuiAddress(grantee.trim());
  const capMist = useMemo(() => {
    const n = Number(capSui);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return parseMistAmount(BigInt(Math.round(n * 1_000_000_000)));
  }, [capSui]);

  const canMint =
    config !== undefined && parsedGrantee.ok && capMist !== undefined;

  return (
    <form
      className="wager-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canMint) return;
        runMarketTx(
          buildMintInviteTransaction(
            config,
            market.id,
            parsedGrantee.value,
            capMist,
            market.closeMs,
          ),
        );
        setGrantee("");
      }}
    >
      <label className="stake-input">
        <span>Invite address</span>
        <input
          type="text"
          value={grantee}
          onChange={(e) => setGrantee(e.target.value)}
          data-testid="mint-invite-address"
          placeholder="0x..."
        />
      </label>
      <label className="stake-input">
        <span>Cap (SUI)</span>
        <input
          type="number"
          min="0"
          step="0.000000001"
          value={capSui}
          onChange={(e) => setCapSui(e.target.value)}
          data-testid="mint-invite-cap"
        />
      </label>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={!canMint}
        data-testid="mint-invite-submit"
      >
        Mint invite
      </button>
    </form>
  );
}

function PositionsCard({
  market,
  state,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  return (
    <Card title="Positions">
      {market.positions.length === 0 ? (
        <p className="card-empty">No wagers yet.</p>
      ) : (
        <ul className="position-list">
          {market.positions.map((p) => {
            const profile = state.users.get(p.owner);
            const winning =
              market.settledOutcome !== undefined &&
              (market.settledOutcome === "invalid" ||
                p.outcome === market.settledOutcome);
            return (
              <li
                key={p.id}
                className="position-row"
                data-testid={`position-${p.id}`}
              >
                <span className={`outcome-chip outcome-${p.outcome}`}>
                  {p.outcome.toUpperCase()}
                </span>
                <span className="position-owner">
                  {profile?.displayName ?? p.owner}
                </span>
                <span className="position-amount">
                  {formatSui(p.amountMist)}
                </span>
                {market.settledOutcome !== undefined ? (
                  <span
                    className={
                      winning ? "position-tag winning" : "position-tag losing"
                    }
                  >
                    {winning ? (p.claimed ? "claimed" : "claim ready") : "lost"}
                  </span>
                ) : null}
                {market.phase === "settled" &&
                winning &&
                !p.claimed &&
                p.owner === state.viewer ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    data-testid="claim-payout"
                    disabled={config === undefined}
                    onClick={() => {
                      if (config !== undefined) {
                        runMarketTx(
                          buildClaimTransaction(config, market.id, p.id),
                        );
                      }
                    }}
                  >
                    Claim
                  </button>
                ) : null}
                {(market.phase === "expired" ||
                  market.phase === "cancelled" ||
                  market.phase === "invalid-refund") &&
                !p.claimed &&
                p.owner === state.viewer ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    data-testid="refund-position"
                    disabled={config === undefined}
                    onClick={() => {
                      if (config !== undefined) {
                        runMarketTx(
                          buildRefundTransaction(config, market.id, p.id),
                        );
                      }
                    }}
                  >
                    Refund
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ActionsCard({
  market,
  state,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  const accepted = market.invites.find(
    (i) => i.invitee === state.viewer && i.accepted,
  );
  const alreadyStaked = market.positions
    .filter((p) => p.owner === state.viewer)
    .reduce<bigint>((sum, p) => sum + p.amountMist, 0n);
  const remainingStakeMist =
    accepted === undefined
      ? 0n
      : accepted.maxStakeMist > alreadyStaked
        ? accepted.maxStakeMist - alreadyStaked
        : 0n;
  const canWager = market.phase === "trading" && remainingStakeMist > 0n;
  const canFinalize =
    market.phase === "challenge-window-open" ||
    market.phase === "locked" ||
    market.phase === "attestation-pending";
  return (
    <Card title="Place wager">
      {canWager ? (
        <WagerForm
          maxStakeMist={remainingStakeMist}
          disabled={config === undefined}
          onSubmit={(outcome, amountMist) =>
            config !== undefined
              ? runMarketTx(
                  buildPlaceTransaction(
                    config,
                    market.id,
                    accepted!.id,
                    outcome,
                    amountMist,
                  ),
                )
              : undefined
          }
        />
      ) : (
        <p className="card-empty">
          {market.phase !== "trading"
            ? `Trading is closed (${phaseLabel(market.phase)}).`
            : accepted === undefined
              ? "Accept your invite to place a wager."
              : "Stake cap reached for this invite."}
        </p>
      )}
      {canFinalize ? (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="finalize-market"
          disabled={config === undefined}
          onClick={() => {
            if (config !== undefined) {
              runMarketTx(buildFinalizeTransaction(config, market.id));
            }
          }}
        >
          Finalize
        </button>
      ) : null}
    </Card>
  );
}

function WagerForm({
  maxStakeMist,
  disabled,
  onSubmit,
}: {
  readonly maxStakeMist: bigint;
  readonly disabled?: boolean;
  readonly onSubmit: (
    outcome: WagerOutcome,
    amountMist: ReturnType<typeof parseMistAmount>,
  ) => void;
}): JSX.Element {
  const [outcome, setOutcome] = useState<WagerOutcome>("yes");
  const defaultStake = useMemo(
    () => defaultStakeInput(maxStakeMist),
    [maxStakeMist],
  );
  const [stake, setStake] = useState(defaultStake);
  useEffect(() => {
    setStake(defaultStake);
  }, [defaultStake]);
  const max = useMemo(
    () => Number(maxStakeMist) / 1_000_000_000,
    [maxStakeMist],
  );
  const parsed = useMemo(() => {
    const n = Number(stake);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    if (n > max) return undefined;
    try {
      return parseMistAmount(BigInt(Math.round(n * 1_000_000_000)));
    } catch {
      return undefined;
    }
  }, [stake, max]);

  return (
    <form
      className="wager-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed === undefined) return;
        onSubmit(outcome, parsed);
      }}
    >
      <div className="outcome-toggle" role="radiogroup">
        <label
          className={outcome === "yes" ? "outcome-yes active" : "outcome-yes"}
        >
          <input
            type="radio"
            name="outcome"
            value="yes"
            checked={outcome === "yes"}
            onChange={() => setOutcome("yes")}
            data-testid="wager-yes"
          />
          YES
        </label>
        <label
          className={outcome === "no" ? "outcome-no active" : "outcome-no"}
        >
          <input
            type="radio"
            name="outcome"
            value="no"
            checked={outcome === "no"}
            onChange={() => setOutcome("no")}
            data-testid="wager-no"
          />
          NO
        </label>
      </div>
      <label className="stake-input">
        <span>Stake (SUI)</span>
        <input
          type="number"
          step="0.000000001"
          min="0"
          max={max}
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          data-testid="wager-amount"
        />
      </label>
      <div className="wager-meta">cap {formatSui(maxStakeMist)}</div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={disabled || parsed === undefined}
        data-testid="wager-submit"
      >
        Place wager
      </button>
    </form>
  );
}

function defaultStakeInput(maxStakeMist: bigint): string {
  const mist =
    maxStakeMist < DEFAULT_WAGER_MIST ? maxStakeMist : DEFAULT_WAGER_MIST;
  return formatMistInput(mist);
}

function formatMistInput(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const fractional = mist % 1_000_000_000n;
  if (fractional === 0n) return whole.toString();
  return `${whole}.${fractional.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

function AttestationCard({
  market,
  state,
  config,
  runMarketTx,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly config: PairmarketMoveConfig | undefined;
  readonly runMarketTx: RunMarketTx;
}): JSX.Element {
  const viewerSubject = market.subjects.find((s) => s.user === state.viewer);
  const viewerAttested = market.attestations.some(
    (a) => a.attestor === state.viewer,
  );
  return (
    <Card title="Attestations">
      {market.attestations.length === 0 ? (
        <p className="card-empty">No attestations yet.</p>
      ) : (
        <ul className="attestation-list">
          {market.attestations.map((a) => {
            const profile = state.users.get(a.attestor);
            return (
              <li key={`${a.attestor}-${a.atMs}`} className="attestation-row">
                <span className="attestation-who">
                  {profile?.displayName ?? a.attestor}
                </span>
                <span className={`outcome-chip outcome-${a.outcome}`}>
                  {a.outcome.toUpperCase()}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {viewerSubject &&
      market.phase === "attestation-pending" &&
      !viewerAttested ? (
        <div className="attestation-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="attest-yes"
            disabled={config === undefined}
            onClick={() => {
              if (config !== undefined) {
                runMarketTx(
                  buildSubmitAttestationTransaction(config, market.id, "yes"),
                );
              }
            }}
          >
            Attest YES
          </button>
          <button
            type="button"
            className="btn"
            data-testid="attest-no"
            disabled={config === undefined}
            onClick={() => {
              if (config !== undefined) {
                runMarketTx(
                  buildSubmitAttestationTransaction(config, market.id, "no"),
                );
              }
            }}
          >
            Attest NO
          </button>
          <button
            type="button"
            className="btn btn-warn"
            data-testid="attest-invalid"
            disabled={config === undefined}
            onClick={() => {
              if (config !== undefined) {
                runMarketTx(
                  buildSubmitAttestationTransaction(
                    config,
                    market.id,
                    "invalid",
                  ),
                );
              }
            }}
          >
            Attest INVALID
          </button>
        </div>
      ) : null}
    </Card>
  );
}
