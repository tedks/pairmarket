import type { JSX } from "react";
import { useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import {
  parseSuiAddress,
  parseUnixMs,
  tryParseSuiAddress,
} from "@pairmarket/core";
import type { Route } from "../App.tsx";
import type { OperationalizationKind } from "../types.ts";
import { requirePairmarketMoveConfig } from "../sui/config.ts";
import {
  buildCreateMarketTransaction,
  findCreatedMarketId,
} from "../sui/market.ts";
import { saveLocalMarketMetadata } from "../sui/metadata.ts";
import { useExecuteSuiTransaction } from "../sui/execute.ts";

type Props = {
  readonly setRoute: (r: Route) => void;
  readonly refresh: () => void;
};

type OpKindLabel = OperationalizationKind["kind"];

export function CreateMarket({ setRoute, refresh }: Props): JSX.Element {
  const account = useCurrentAccount();
  const execute = useExecuteSuiTransaction();
  const [title, setTitle] = useState("Will X and Y last 3 dates?");
  const [prompt, setPrompt] = useState(
    "Three dates means three meetings of at least 90 minutes with mutual intent.",
  );
  const [subjectA, setSubjectA] = useState("");
  const [subjectB, setSubjectB] = useState("");
  const [opKind, setOpKind] = useState<OpKindLabel>("lasts-n-dates");
  const [nDates, setNDates] = useState(3);
  const [closeDays, setCloseDays] = useState(7);
  const [resolutionDeadlineDays, setResolutionDeadlineDays] = useState(21);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const parsedSubjectA = tryParseSuiAddress(subjectA.trim());
  const parsedSubjectB = tryParseSuiAddress(subjectB.trim());
  const deadlineOrderError =
    closeDays < resolutionDeadlineDays
      ? undefined
      : "Close deadline must be before the resolution deadline.";

  const canSubmit =
    account !== null &&
    title.trim().length > 0 &&
    parsedSubjectA.ok &&
    parsedSubjectB.ok &&
    parsedSubjectA.value !== parsedSubjectB.value &&
    resolutionDeadlineDays > 0 &&
    closeDays > 0 &&
    deadlineOrderError === undefined &&
    !submitting;

  return (
    <section className="create-market">
      <header className="market-list-head">
        <h1>New market</h1>
        <p className="market-list-sub">
          Drafts go to "Awaiting consent" until both subjects accept.
        </p>
      </header>

      <form
        className="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(undefined);
          if (!canSubmit) return;
          setSubmitting(true);
          void (async () => {
            try {
              const config = requirePairmarketMoveConfig();
              const now = Date.now();
              const challengeWindowMs = 2 * 86_400_000;
              const closeMs = now + closeDays * 86_400_000;
              const resolutionDeadlineMs =
                now + resolutionDeadlineDays * 86_400_000;
              const operationalization: OperationalizationKind =
                opKind === "lasts-n-dates"
                  ? { kind: "lasts-n-dates", n: nDates }
                  : opKind === "together-by-date"
                    ? {
                        kind: "together-by-date",
                        deadlineMs: parseUnixMs(closeMs),
                      }
                    : {
                        kind: "meet-by-date",
                        deadlineMs: parseUnixMs(closeMs),
                      };
              const tx = await buildCreateMarketTransaction({
                config,
                creator: parseSuiAddress(account!.address),
                operationalization,
                title,
                prompt,
                subjectA: parsedSubjectA.value,
                subjectB: parsedSubjectB.value,
                closeMs,
                earliestAttestMs: closeMs,
                resolutionDeadlineMs,
                challengeWindowMs,
                disputeDeadlineMs: resolutionDeadlineMs + challengeWindowMs,
                feeBps: 0,
                resolverCommittee: [parseSuiAddress(account!.address)],
              });
              const result = await execute(tx);
              const marketId = findCreatedMarketId(result);
              if (marketId !== undefined) {
                saveLocalMarketMetadata(config.packageId, marketId, {
                  title,
                  prompt,
                  operationalization,
                });
                refresh();
                setRoute({ kind: "market", id: marketId });
              } else {
                refresh();
                setRoute({ kind: "markets", filter: "all" });
              }
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setSubmitting(false);
            }
          })();
        }}
      >
        <div className="form-grid">
          <Field label="Title">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="create-title"
              required
            />
          </Field>
          <Field label="Prompt">
            <textarea
              value={prompt}
              rows={3}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="create-prompt"
            />
          </Field>

          <Field label="Subject A">
            <input
              type="text"
              value={subjectA}
              onChange={(e) => setSubjectA(e.target.value)}
              data-testid="create-subject-a"
              placeholder="0x..."
              required
            />
          </Field>
          <Field label="Subject B">
            <input
              type="text"
              value={subjectB}
              onChange={(e) => setSubjectB(e.target.value)}
              data-testid="create-subject-b"
              placeholder="0x..."
              required
            />
          </Field>

          <Field label="Operationalization">
            <select
              value={opKind}
              onChange={(e) => setOpKind(e.target.value as OpKindLabel)}
              data-testid="create-op-kind"
            >
              <option value="lasts-n-dates">Lasts N dates</option>
              <option value="together-by-date">Together by date</option>
              <option value="meet-by-date">Meet by date</option>
            </select>
          </Field>
          {opKind === "lasts-n-dates" ? (
            <Field label="N dates">
              <input
                type="number"
                min={1}
                max={20}
                value={nDates}
                onChange={(e) => setNDates(Number(e.target.value))}
              />
            </Field>
          ) : (
            <Field label="Close deadline (days)">
              <input
                type="number"
                min={1}
                max={365}
                value={closeDays}
                onChange={(e) => setCloseDays(Number(e.target.value))}
                data-testid="create-op-deadline-days"
              />
            </Field>
          )}
          <Field label="Resolution deadline (days)">
            <input
              type="number"
              min={1}
              max={365}
              value={resolutionDeadlineDays}
              onChange={(e) =>
                setResolutionDeadlineDays(Number(e.target.value))
              }
              data-testid="create-deadline-days"
            />
          </Field>
        </div>

        {deadlineOrderError ? (
          <p className="form-error" data-testid="create-deadline-error">
            {deadlineOrderError}
          </p>
        ) : null}
        {parsedSubjectA.ok || subjectA.trim() === "" ? null : (
          <p className="form-error">Subject A must be a Sui address.</p>
        )}
        {parsedSubjectB.ok || subjectB.trim() === "" ? null : (
          <p className="form-error">Subject B must be a Sui address.</p>
        )}
        {account === null ? (
          <p className="form-error">Connect a Sui wallet to create a market.</p>
        ) : null}
        {err ? <p className="form-error">{err}</p> : null}

        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setRoute({ kind: "markets", filter: "all" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            data-testid="create-submit"
          >
            {submitting ? "Creating..." : "Create market"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
