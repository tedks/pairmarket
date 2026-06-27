#[test_only]
module pairmarket::placeholder_tests {
    use pairmarket::placeholder;

    #[test]
    fun marker_exists() {
        placeholder::package_marker();
    }
}
