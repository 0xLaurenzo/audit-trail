{
  description = "Decision auditing and GitHub PR summaries for the pi coding agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-audit-trail";
            version = "0.3.0";
            src = self;

            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/pi-audit-trail" "$out/bin"
              cp -R src "$out/share/pi-audit-trail/src"
              find "$out/share/pi-audit-trail/src" -type f -exec chmod 444 {} +
              install -Dm444 README.md "$out/share/pi-audit-trail/README.md"
              install -Dm444 package.json "$out/share/pi-audit-trail/package.json"
              cat > "$out/bin/audit-trail" <<WRAPPER
              #!${pkgs.runtimeShell}
              exec ${pkgs.nodejs_24}/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning "$out/share/pi-audit-trail/src/cli/bin.ts" "\$@"
              WRAPPER
              chmod 755 "$out/bin/audit-trail"
              runHook postInstall
            '';

            meta = {
              description = "Append-only decision auditing and GitHub PR summaries for pi";
              homepage = "https://github.com/0xLaurenzo/audit-trail";
              platforms = systems;
            };
          };
        });
    };
}
