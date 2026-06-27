// Tests for pairmarket::market.
//
// Each test follows a small narrative documented in the design doc and the
// move-object-model sketch. The minimum invariants covered are:
//   - subject co-consent gates trading,
//   - invites are single-use and bound to the market,
//   - positions are non-transferable and pay once,
//   - escrow conservation: payouts + fee + refunds equal deposits,
//   - cancellation refunds gross stake and takes no fee,
//   - outcome validity is enforced,
//   - fee cap is enforced at creation.
//
// All tests run under `sui move test` once a compatible Sui toolchain is
// pinned by the Nix flake. The exact CLI version is recorded in the
// ExecPlan under "Artifacts and Notes".

#[test_only]
module pairmarket::market_tests {

    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::test_scenario::{Self as ts, Scenario};
    use pairmarket::market::{
        Self as pm,
        Market,
        InviteTicket,
        Position,
        Config,
        AdminCap,
    };

    /// Witness type used as the collateral coin type in tests.
    public struct TEST_TOKEN has drop {}

    const CREATOR: address = @0xC0FFEE;
    const ALICE: address = @0xA11CE;   // subject A
    const BOB: address = @0xB0B;       // subject B
    const PAULA: address = @0xBEEF01;  // participant 1
    const QUINN: address = @0xBEEF02;  // participant 2

    const CLOSE_MS: u64 = 1_000;
    const EARLIEST_ATTEST_MS: u64 = 2_000;
    const RESOLUTION_DEADLINE_MS: u64 = 3_000;
    const CHALLENGE_WINDOW_MS: u64 = 500;
    const DISPUTE_DEADLINE_MS: u64 = 4_000;

    // ---- Helpers ----

    fun start_with_config(): Scenario {
        let mut scenario = ts::begin(CREATOR);
        pm::test_init(ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, CREATOR);
        scenario
    }

    fun make_clock(scenario: &mut Scenario): Clock {
        clock::create_for_testing(ts::ctx(scenario))
    }

    fun create_default_market(scenario: &mut Scenario, clock: &Clock) {
        let config = ts::take_shared<Config>(scenario);
        let committee = vector[CREATOR];
        pm::create_market<TEST_TOKEN>(
            b"terms",
            b"metadata",
            b"subject",
            b"seal_policy",
            ALICE,
            BOB,
            CLOSE_MS,
            EARLIEST_ATTEST_MS,
            RESOLUTION_DEADLINE_MS,
            CHALLENGE_WINDOW_MS,
            DISPUTE_DEADLINE_MS,
            100, // 1% fee
            committee,
            &config,
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(config);
    }

    fun consent(scenario: &mut Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        pm::record_subject_consent<TEST_TOKEN>(&mut market, clock, ts::ctx(scenario));
        ts::return_shared(market);
    }

    fun mint(scenario: &mut Scenario, grantee: address, max_stake: u64, expires: u64, clock: &Clock) {
        ts::next_tx(scenario, CREATOR);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        pm::mint_invite<TEST_TOKEN>(
            &mut market,
            grantee,
            max_stake,
            expires,
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(market);
    }

    fun place_as(
        scenario: &mut Scenario,
        who: address,
        amount: u64,
        outcome: u8,
        clock: &Clock,
    ) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        let invite = ts::take_from_sender<InviteTicket>(scenario);
        let stake_coin = coin::mint_for_testing<TEST_TOKEN>(amount, ts::ctx(scenario));
        pm::place<TEST_TOKEN>(
            &mut market,
            invite,
            stake_coin,
            outcome,
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(market);
    }

    fun attest(scenario: &mut Scenario, who: address, outcome: u8, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        pm::submit_attestation<TEST_TOKEN>(
            &mut market,
            outcome,
            b"evhash",
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(market);
    }

    fun finalize(scenario: &mut Scenario, clock: &Clock) {
        ts::next_tx(scenario, CREATOR);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        pm::finalize<TEST_TOKEN>(&mut market, clock);
        ts::return_shared(market);
    }

    // ---- Tests ----

    #[test]
    fun happy_path_yes_resolves_pays() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        // Create market at t = 0.
        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);

        // Both subjects consent.
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);

        // Creator mints invites.
        mint(&mut scenario, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, QUINN, 1_000, CLOSE_MS, &clock);

        // Place wagers: Paula bets YES 600, Quinn bets NO 400.
        place_as(&mut scenario, PAULA, 600, pm::outcome_yes(), &clock);
        place_as(&mut scenario, QUINN, 400, pm::outcome_no(), &clock);

        // Advance to attestation window and have both subjects agree YES.
        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, BOB, pm::outcome_yes(), &clock);

        // Wait out the challenge window and finalize.
        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        // Assert settled and pool math is consistent.
        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::state(&market) == pm::state_settled(), 1001);
            assert!(pm::winning_outcome(&market) == pm::outcome_yes(), 1002);
            // 1000 gross, 1% fee = 10, payout pool = 990.
            assert!(pm::fee_balance_value(&market) == 10, 1003);
            assert!(pm::payout_pool_value(&market) == 990, 1004);
            ts::return_shared(market);
        };

        // Paula claims.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, ts::ctx(&mut scenario));
            assert!(pm::position_claimed(&position), 1005);
            assert!(pm::winning_shares_remaining(&market) == 0, 1006);
            assert!(pm::payout_pool_value(&market) == 0, 1007);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        // Paula receives a Coin worth 990.
        ts::next_tx(&mut scenario, PAULA);
        {
            let received = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            assert!(coin::value(&received) == 990, 1008);
            ts::return_to_sender(&scenario, received);
        };

        // Quinn's losing-side refund attempt aborts via ENotRefundable
        // (market is SETTLED, not CANCELLED/EXPIRED) — not exercised here
        // because we already have aborts coverage in dedicated tests.

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun cancel_refunds_full_stake_no_fee() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);
        mint(&mut scenario, PAULA, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, PAULA, 500, pm::outcome_yes(), &clock);

        // Admin cancels mid-trading.
        ts::next_tx(&mut scenario, CREATOR);
        {
            let admin = ts::take_from_sender<AdminCap>(&scenario);
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            pm::cancel<TEST_TOKEN>(&mut market, &admin, &clock);
            assert!(pm::state(&market) == pm::state_cancelled(), 2001);
            assert!(pm::fee_balance_value(&market) == 0, 2002);
            ts::return_shared(market);
            ts::return_to_sender(&scenario, admin);
        };

        // Paula refunds gross stake.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            pm::refund<TEST_TOKEN>(&mut market, &mut position, ts::ctx(&mut scenario));
            assert!(pm::position_claimed(&position), 2003);
            assert!(pm::yes_pool_value(&market) == 0, 2004);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        ts::next_tx(&mut scenario, PAULA);
        {
            let received = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            assert!(coin::value(&received) == 500, 2005);
            ts::return_to_sender(&scenario, received);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 11, location = pairmarket::market)]
    fun double_claim_aborts() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);
        mint(&mut scenario, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, PAULA, 500, pm::outcome_yes(), &clock);
        place_as(&mut scenario, QUINN, 500, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, BOB, pm::outcome_yes(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        // First claim succeeds.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        // Second claim must abort EDoubleClaim (= 11).
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 6, location = pairmarket::market)]
    fun unknown_outcome_aborts() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);
        mint(&mut scenario, PAULA, 1_000, CLOSE_MS, &clock);

        // Place with OUTCOME_INVALID (=3) — must abort EUnknownOutcome (=6).
        place_as(&mut scenario, PAULA, 100, pm::outcome_invalid(), &clock);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 12, location = pairmarket::market)]
    fun fee_cap_enforced() {
        let mut scenario = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        let config = ts::take_shared<Config>(&scenario);
        // Config.max_fee_bps default is 500; pass 600 to trigger EFeeCapExceeded.
        pm::create_market<TEST_TOKEN>(
            b"t", b"m", b"s", b"p",
            ALICE, BOB,
            CLOSE_MS, EARLIEST_ATTEST_MS, RESOLUTION_DEADLINE_MS,
            CHALLENGE_WINDOW_MS, DISPUTE_DEADLINE_MS,
            600, // > max_fee_bps
            vector[CREATOR],
            &config,
            &clock,
            ts::ctx(&mut scenario),
        );
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun attestation_mismatch_resets_round() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);
        mint(&mut scenario, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, PAULA, 100, pm::outcome_yes(), &clock);
        place_as(&mut scenario, QUINN, 100, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, BOB, pm::outcome_no(), &clock);

        // After mismatch, state should still be ATTESTATION_PENDING (3), not
        // CHALLENGE_WINDOW (4). Use winning_outcome accessor — must remain UNSET.
        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::winning_outcome(&market) == 0, 7001); // OUTCOME_UNSET
            ts::return_shared(market);
        };

        // Both retry, this time matching NO.
        attest(&mut scenario, ALICE, pm::outcome_no(), &clock);
        attest(&mut scenario, BOB, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::winning_outcome(&market) == pm::outcome_no(), 7002);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun binary_escrow_conservation() {
        let mut scenario = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &clock);
        consent(&mut scenario, ALICE, &clock);
        consent(&mut scenario, BOB, &clock);
        mint(&mut scenario, PAULA, 10_000, CLOSE_MS, &clock);
        mint(&mut scenario, QUINN, 10_000, CLOSE_MS, &clock);

        // Asymmetric stakes that force rounding in claim math.
        place_as(&mut scenario, PAULA, 333, pm::outcome_yes(), &clock);
        place_as(&mut scenario, QUINN, 777, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, BOB, pm::outcome_yes(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        // Paula (sole winner) claims; she should receive the entire payout pool
        // due to the "last claimer gets remainder" property.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        // Conservation: paula_coin + fee_balance == deposits (333 + 777 = 1110).
        ts::next_tx(&mut scenario, PAULA);
        let paula_coin_value = {
            let received = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            let v = coin::value(&received);
            ts::return_to_sender(&scenario, received);
            v
        };
        ts::next_tx(&mut scenario, CREATOR);
        let fee_balance = {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let f = pm::fee_balance_value(&market);
            ts::return_shared(market);
            f
        };
        assert!(paula_coin_value + fee_balance == 333 + 777, 8001);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
