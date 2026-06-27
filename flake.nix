{
  description = "pairmarket Phase 0 toolchain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          sui = pkgs.stdenv.mkDerivation {
            pname = "sui";
            version = "mainnet-v1.73.2";

            src = pkgs.fetchurl {
              url = "https://github.com/MystenLabs/sui/releases/download/mainnet-v1.73.2/sui-mainnet-v1.73.2-ubuntu-x86_64.tgz";
              hash = "sha256-EYlODmXWywbPH6JD3+IYvUQT6nZ3YAo7D3yniGOkqeA=";
            };

            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            buildInputs = [
              pkgs.stdenv.cc.cc.lib
              pkgs.openssl
              pkgs.zlib
            ];
            sourceRoot = ".";

            installPhase = ''
              runHook preInstall

              install -Dm755 sui "$out/bin/sui"
              install -Dm755 move-analyzer "$out/bin/move-analyzer"

              runHook postInstall
            '';
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          sui = self.packages.${system}.sui;
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.writeShellApplication {
            name = "pnpm";
            runtimeInputs = [ nodejs ];
            text = ''
              export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
              export COREPACK_HOME="''${COREPACK_HOME:-''${XDG_CACHE_HOME:-$HOME/.cache}/pairmarket/corepack}"
              exec corepack pnpm "$@"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              sui
              pkgs.git
            ];

            shellHook = ''
              echo "pairmarket toolchain: node $(node --version), pnpm $(pnpm --version), $(sui --version)"
            '';
          };
        }
      );
    };
}
