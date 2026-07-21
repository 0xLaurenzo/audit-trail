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
              install -Dm444 index.ts "$out/share/pi-audit-trail/index.ts"
              cp -R src "$out/share/pi-audit-trail/src"
              find "$out/share/pi-audit-trail/src" -type f -exec chmod 444 {} +
              install -Dm444 README.md "$out/share/pi-audit-trail/README.md"
              install -Dm444 package.json "$out/share/pi-audit-trail/package.json"
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
