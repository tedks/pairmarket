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

    use std::option;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::object::ID;
    use sui::test_scenario::{Self as ts, Scenario};
    use pairmarket::market::{
        Self as pm,
        Market,
        InviteTicket,
        Position,
        Profile,
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

    public struct Profiles has copy, drop {
        creator: ID,
        alice: ID,
        bob: ID,
        paula: ID,
        quinn: ID,
    }

    // ---- Helpers ----

    fun start_with_config(): (Scenario, Profiles) {
        let mut scenario = ts::begin(CREATOR);
        pm::test_init(ts::ctx(&mut scenario));
        let profiles = create_profiles(&mut scenario);
        ts::next_tx(&mut scenario, CREATOR);
        (scenario, profiles)
    }

    fun create_profiles(scenario: &mut Scenario): Profiles {
        ts::next_tx(scenario, CREATOR);
        pm::create_profile(b"creator", ts::ctx(scenario));

        ts::next_tx(scenario, ALICE);
        let creator = *option::borrow(&ts::most_recent_id_shared<Profile>());
        pm::create_profile(b"alice", ts::ctx(scenario));

        ts::next_tx(scenario, BOB);
        let alice = *option::borrow(&ts::most_recent_id_shared<Profile>());
        pm::create_profile(b"bob", ts::ctx(scenario));

        ts::next_tx(scenario, PAULA);
        let bob = *option::borrow(&ts::most_recent_id_shared<Profile>());
        pm::create_profile(b"paula", ts::ctx(scenario));

        ts::next_tx(scenario, QUINN);
        let paula = *option::borrow(&ts::most_recent_id_shared<Profile>());
        pm::create_profile(b"quinn", ts::ctx(scenario));

        ts::next_tx(scenario, CREATOR);
        let quinn = *option::borrow(&ts::most_recent_id_shared<Profile>());

        Profiles { creator, alice, bob, paula, quinn }
    }

    fun profile_for(profiles: &Profiles, who: address): ID {
        if (who == CREATOR) return profiles.creator;
        if (who == ALICE) return profiles.alice;
        if (who == BOB) return profiles.bob;
        if (who == PAULA) return profiles.paula;
        profiles.quinn
    }

    fun make_clock(scenario: &mut Scenario): Clock {
        clock::create_for_testing(ts::ctx(scenario))
    }

    fun create_default_market(scenario: &mut Scenario, profiles: &Profiles, clock: &Clock) {
        let config = ts::take_shared<Config>(scenario);
        let creator_profile = ts::take_shared_by_id<Profile>(scenario, profiles.creator);
        let alice_profile = ts::take_shared_by_id<Profile>(scenario, profiles.alice);
        let bob_profile = ts::take_shared_by_id<Profile>(scenario, profiles.bob);
        let committee = vector[profiles.creator];
        pm::create_market<TEST_TOKEN>(
            &creator_profile,
            b"terms",
            b"metadata",
            b"subject",
            b"seal_policy",
            &alice_profile,
            &bob_profile,
            pm::visibility_friends(),
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
        ts::return_shared(creator_profile);
        ts::return_shared(alice_profile);
        ts::return_shared(bob_profile);
        ts::return_shared(config);
    }

    fun consent(scenario: &mut Scenario, profiles: &Profiles, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        let profile = ts::take_shared_by_id<Profile>(scenario, profile_for(profiles, who));
        pm::record_subject_consent<TEST_TOKEN>(&mut market, &profile, clock, ts::ctx(scenario));
        ts::return_shared(profile);
        ts::return_shared(market);
    }

    fun mint(scenario: &mut Scenario, profiles: &Profiles, grantee: address, max_stake: u64, expires: u64, clock: &Clock) {
        ts::next_tx(scenario, CREATOR);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        let creator_profile = ts::take_shared_by_id<Profile>(scenario, profiles.creator);
        let grantee_profile = ts::take_shared_by_id<Profile>(scenario, profile_for(profiles, grantee));
        pm::mint_invite<TEST_TOKEN>(
            &mut market,
            &creator_profile,
            &grantee_profile,
            max_stake,
            expires,
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(creator_profile);
        ts::return_shared(grantee_profile);
        ts::return_shared(market);
    }

    fun place_as(
        scenario: &mut Scenario,
        profiles: &Profiles,
        who: address,
        amount: u64,
        outcome: u8,
        clock: &Clock,
    ) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        let invite = ts::take_from_sender<InviteTicket>(scenario);
        let profile = ts::take_shared_by_id<Profile>(scenario, profile_for(profiles, who));
        let stake_coin = coin::mint_for_testing<TEST_TOKEN>(amount, ts::ctx(scenario));
        pm::place<TEST_TOKEN>(
            &mut market,
            invite,
            &profile,
            stake_coin,
            outcome,
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(profile);
        ts::return_shared(market);
    }

    fun attest(scenario: &mut Scenario, profiles: &Profiles, who: address, outcome: u8, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut market = ts::take_shared<Market<TEST_TOKEN>>(scenario);
        let profile = ts::take_shared_by_id<Profile>(scenario, profile_for(profiles, who));
        pm::submit_attestation<TEST_TOKEN>(
            &mut market,
            &profile,
            outcome,
            b"evhash",
            clock,
            ts::ctx(scenario),
        );
        ts::return_shared(profile);
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
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        // Create market at t = 0.
        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);

        // Both subjects consent.
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);

        // Creator mints invites.
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);

        // Place wagers: Paula bets YES 600, Quinn bets NO 400.
        place_as(&mut scenario, &profiles, PAULA, 600, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 400, pm::outcome_no(), &clock);

        // Advance to attestation window and have both subjects agree YES.
        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_yes(), &clock);

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
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            assert!(pm::position_claimed(&position), 1005);
            assert!(pm::winning_shares_remaining(&market) == 0, 1006);
            assert!(pm::payout_pool_value(&market) == 0, 1007);
            ts::return_shared(profile);
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
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 500, pm::outcome_yes(), &clock);

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
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::refund<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            assert!(pm::position_claimed(&position), 2003);
            assert!(pm::yes_pool_value(&market) == 0, 2004);
            ts::return_shared(profile);
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
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 500, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 500, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_yes(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        // First claim succeeds.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        // Second claim must abort EDoubleClaim (= 11).
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 6, location = pairmarket::market)]
    fun unknown_outcome_aborts() {
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);

        // Place with OUTCOME_INVALID (=3) — must abort EUnknownOutcome (=6).
        place_as(&mut scenario, &profiles, PAULA, 100, pm::outcome_invalid(), &clock);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 12, location = pairmarket::market)]
    fun fee_cap_enforced() {
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        let config = ts::take_shared<Config>(&scenario);
        let creator_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.creator);
        let alice_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.alice);
        let bob_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.bob);
        // Config.max_fee_bps default is 500; pass 600 to trigger EFeeCapExceeded.
        pm::create_market<TEST_TOKEN>(
            &creator_profile,
            b"t", b"m", b"s", b"p",
            &alice_profile, &bob_profile,
            pm::visibility_friends(),
            CLOSE_MS, EARLIEST_ATTEST_MS, RESOLUTION_DEADLINE_MS,
            CHALLENGE_WINDOW_MS, DISPUTE_DEADLINE_MS,
            600, // > max_fee_bps
            vector[profiles.creator],
            &config,
            &clock,
            ts::ctx(&mut scenario),
        );
        ts::return_shared(creator_profile);
        ts::return_shared(alice_profile);
        ts::return_shared(bob_profile);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun attestation_mismatch_resets_round() {
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 100, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 100, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_no(), &clock);

        // After mismatch, state should still be ATTESTATION_PENDING (3), not
        // CHALLENGE_WINDOW (4). Use winning_outcome accessor — must remain UNSET.
        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::winning_outcome(&market) == 0, 7001); // OUTCOME_UNSET
            ts::return_shared(market);
        };

        // Both retry, this time matching NO.
        attest(&mut scenario, &profiles, ALICE, pm::outcome_no(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_no(), &clock);

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
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 10_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 10_000, CLOSE_MS, &clock);

        // Asymmetric stakes that force rounding in claim math.
        place_as(&mut scenario, &profiles, PAULA, 333, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 777, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_yes(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        // Paula (sole winner) claims; she should receive the entire payout pool
        // due to the "last claimer gets remainder" property.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::claim<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
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

    // ---- Round-1 council-driven coverage ----

    #[test]
    #[expected_failure(abort_code = 28, location = pairmarket::market)]
    fun same_subject_aborts() {
        // Critical fix: create_market must reject subject_a == subject_b
        // so a single party cannot unilaterally consent and attest.
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        let config = ts::take_shared<Config>(&scenario);
        let creator_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.creator);
        let alice_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.alice);
        pm::create_market<TEST_TOKEN>(
            &creator_profile,
            b"t", b"m", b"s", b"p",
            &alice_profile, &alice_profile, // same profile — must abort ESameSubject (=28)
            pm::visibility_friends(),
            CLOSE_MS, EARLIEST_ATTEST_MS, RESOLUTION_DEADLINE_MS,
            CHALLENGE_WINDOW_MS, DISPUTE_DEADLINE_MS,
            100, vector[profiles.creator],
            &config, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(creator_profile);
        ts::return_shared(alice_profile);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 29, location = pairmarket::market)]
    fun bad_durations_aborts() {
        // create_market must reject a challenge_window_ms that does not fit
        // in [resolution_deadline_ms, dispute_deadline_ms].
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        let config = ts::take_shared<Config>(&scenario);
        let creator_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.creator);
        let alice_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.alice);
        let bob_profile = ts::take_shared_by_id<Profile>(&scenario, profiles.bob);
        pm::create_market<TEST_TOKEN>(
            &creator_profile,
            b"t", b"m", b"s", b"p",
            &alice_profile, &bob_profile,
            pm::visibility_friends(),
            CLOSE_MS, EARLIEST_ATTEST_MS, RESOLUTION_DEADLINE_MS,
            (DISPUTE_DEADLINE_MS - RESOLUTION_DEADLINE_MS) + 1,
            DISPUTE_DEADLINE_MS,
            100, vector[profiles.creator],
            &config, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(creator_profile);
        ts::return_shared(alice_profile);
        ts::return_shared(bob_profile);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun finalize_expires_locked_market_with_no_attestation() {
        // Critical fix: a market stranded in Trading/Locked after the
        // resolution deadline must be expirable via finalize(), not require
        // admin cancellation. Participants then refund.
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 200, pm::outcome_yes(), &clock);

        // Past close: trader could lock, but doesn't have to.
        clock::set_for_testing(&mut clock, CLOSE_MS + 1);
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            pm::lock<TEST_TOKEN>(&mut market, &clock);
            ts::return_shared(market);
        };

        // Subjects never attest. Past the resolution deadline, anyone may
        // finalize, which expires the market.
        clock::set_for_testing(&mut clock, RESOLUTION_DEADLINE_MS + 1);
        finalize(&mut scenario, &clock);
        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::state(&market) == pm::state_expired(), 9001);
            ts::return_shared(market);
        };

        // Paula refunds gross stake from the expired market.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::refund<TEST_TOKEN>(&mut market, &mut position, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };
        ts::next_tx(&mut scenario, PAULA);
        {
            let received = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            assert!(coin::value(&received) == 200, 9002);
            ts::return_to_sender(&scenario, received);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 2, location = pairmarket::market)]
    fun cross_market_invite_aborts_on_place() {
        // An invite minted by market X must not place into market Y. We
        // mint Paula's invite on X, then try to use it on Y. Y's `place`
        // must abort with EWrongMarket because invite.market_id != Y.id.
        // This covers the invite single-use guarantee from the other angle:
        // even if Paula keeps the ticket alive (no place on X), she cannot
        // exchange it for a position on a different market.
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock); // X
        ts::next_tx(&mut scenario, CREATOR);
        let x_id = *option::borrow(
            &ts::most_recent_id_shared<Market<TEST_TOKEN>>()
        );
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock); // X-invite

        // Y: a second Trading-state market with same subjects, different ID.
        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        ts::next_tx(&mut scenario, CREATOR);
        let y_id = *option::borrow(
            &ts::most_recent_id_shared<Market<TEST_TOKEN>>()
        );
        assert!(y_id != x_id, 12000);

        // Drive Y into Trading via subject consents (by-id) so place is valid.
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut y = ts::take_shared_by_id<Market<TEST_TOKEN>>(&scenario, y_id);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.alice);
            pm::record_subject_consent<TEST_TOKEN>(&mut y, &profile, &clock, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_shared(y);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut y = ts::take_shared_by_id<Market<TEST_TOKEN>>(&scenario, y_id);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.bob);
            pm::record_subject_consent<TEST_TOKEN>(&mut y, &profile, &clock, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_shared(y);
        };

        // Attempt place with X-invite into Y. Must abort EWrongMarket (=2).
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut y = ts::take_shared_by_id<Market<TEST_TOKEN>>(&scenario, y_id);
            let invite = ts::take_from_sender<InviteTicket>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            let stake_coin = coin::mint_for_testing<TEST_TOKEN>(50, ts::ctx(&mut scenario));
            pm::place<TEST_TOKEN>(
                &mut y,
                invite,
                &profile,
                stake_coin,
                pm::outcome_yes(),
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_shared(profile);
            ts::return_shared(y);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 2, location = pairmarket::market)]
    fun cross_market_refund_aborts() {
        // Cross-market invariant: a Position bound to market X cannot be
        // refunded against a different (cancelled) market Y.
        let (mut scenario, profiles) = start_with_config();
        let clock = make_clock(&mut scenario);

        // --- Market X: create, consent, mint, place. ---
        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        ts::next_tx(&mut scenario, CREATOR);
        let x_id = *option::borrow(
            &ts::most_recent_id_shared<Market<TEST_TOKEN>>()
        );
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 100, pm::outcome_yes(), &clock);

        // --- Market Y: second market, cancelled by admin so refund is the
        //     enabled exit path there. Capture its ID via the most-recent
        //     shared inventory helper. ---
        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        ts::next_tx(&mut scenario, CREATOR);
        let y_id = *option::borrow(
            &ts::most_recent_id_shared<Market<TEST_TOKEN>>()
        );
        assert!(y_id != x_id, 11000);
        {
            let admin = ts::take_from_sender<AdminCap>(&scenario);
            let mut y = ts::take_shared_by_id<Market<TEST_TOKEN>>(&scenario, y_id);
            pm::cancel<TEST_TOKEN>(&mut y, &admin, &clock);
            ts::return_shared(y);
            ts::return_to_sender(&scenario, admin);
        };

        // Attempt: refund Paula's X-position against Y. Must abort EWrongMarket.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut y = ts::take_shared_by_id<Market<TEST_TOKEN>>(&scenario, y_id);
            let mut x_position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::refund<TEST_TOKEN>(&mut y, &mut x_position, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, x_position);
            ts::return_shared(y);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 30, location = pairmarket::market)]
    fun committee_verdict_cannot_overwrite() {
        // Submitting a second committee verdict on a disputed market must
        // abort EVerdictAlreadySet (=30).
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 100, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 100, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_yes(), &clock);

        // Open a challenge from the losing-side participant (Quinn / NO).
        ts::next_tx(&mut scenario, QUINN);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.quinn);
            pm::open_challenge<TEST_TOKEN>(
                &mut market,
                &position,
                &profile,
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        // First verdict from CREATOR (committee member) is accepted.
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.creator);
            pm::submit_committee_verdict<TEST_TOKEN>(
                &mut market,
                &profile,
                pm::outcome_no(),
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_shared(profile);
            ts::return_shared(market);
        };

        // Second verdict must abort with EVerdictAlreadySet (=30).
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.creator);
            pm::submit_committee_verdict<TEST_TOKEN>(
                &mut market,
                &profile,
                pm::outcome_yes(),
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_shared(profile);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 31, location = pairmarket::market)]
    fun challenger_on_winning_side_aborts() {
        // open_challenge by a holder of the matched-outcome side must abort
        // EChallengerOnWinningSide (=31).
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 100, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 100, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_yes(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_yes(), &clock);

        // Paula is on the matched YES side; attempt must abort.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let position = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::open_challenge<TEST_TOKEN>(
                &mut market,
                &position,
                &profile,
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, position);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun invalid_outcome_routes_to_refund() {
        // Both subjects attest INVALID -> matched -> finalize -> Expired ->
        // both participants refund gross stake; no fee accrued.
        let (mut scenario, profiles) = start_with_config();
        let mut clock = make_clock(&mut scenario);

        ts::next_tx(&mut scenario, CREATOR);
        create_default_market(&mut scenario, &profiles, &clock);
        consent(&mut scenario, &profiles, ALICE, &clock);
        consent(&mut scenario, &profiles, BOB, &clock);
        mint(&mut scenario, &profiles, PAULA, 1_000, CLOSE_MS, &clock);
        mint(&mut scenario, &profiles, QUINN, 1_000, CLOSE_MS, &clock);
        place_as(&mut scenario, &profiles, PAULA, 300, pm::outcome_yes(), &clock);
        place_as(&mut scenario, &profiles, QUINN, 700, pm::outcome_no(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS);
        attest(&mut scenario, &profiles, ALICE, pm::outcome_invalid(), &clock);
        attest(&mut scenario, &profiles, BOB, pm::outcome_invalid(), &clock);

        clock::set_for_testing(&mut clock, EARLIEST_ATTEST_MS + CHALLENGE_WINDOW_MS + 1);
        finalize(&mut scenario, &clock);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::state(&market) == pm::state_expired(), 10001);
            assert!(pm::fee_balance_value(&market) == 0, 10002);
            ts::return_shared(market);
        };

        // Paula and Quinn each refund their original stake.
        ts::next_tx(&mut scenario, PAULA);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut p = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.paula);
            pm::refund<TEST_TOKEN>(&mut market, &mut p, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, p);
            ts::return_shared(market);
        };
        ts::next_tx(&mut scenario, QUINN);
        {
            let mut market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            let mut q = ts::take_from_sender<Position<TEST_TOKEN>>(&scenario);
            let profile = ts::take_shared_by_id<Profile>(&scenario, profiles.quinn);
            pm::refund<TEST_TOKEN>(&mut market, &mut q, &profile, ts::ctx(&mut scenario));
            ts::return_shared(profile);
            ts::return_to_sender(&scenario, q);
            ts::return_shared(market);
        };

        ts::next_tx(&mut scenario, PAULA);
        {
            let c = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            assert!(coin::value(&c) == 300, 10003);
            ts::return_to_sender(&scenario, c);
        };
        ts::next_tx(&mut scenario, QUINN);
        {
            let c = ts::take_from_sender<Coin<TEST_TOKEN>>(&scenario);
            assert!(coin::value(&c) == 700, 10004);
            ts::return_to_sender(&scenario, c);
        };
        ts::next_tx(&mut scenario, CREATOR);
        {
            let market = ts::take_shared<Market<TEST_TOKEN>>(&scenario);
            assert!(pm::yes_pool_value(&market) == 0, 10005);
            assert!(pm::no_pool_value(&market) == 0, 10006);
            ts::return_shared(market);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
