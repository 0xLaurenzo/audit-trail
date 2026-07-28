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
          default = pkgs.buildNpmPackage {
            pname = "pi-audit-trail";
            version = "0.3.0";
            src = self;
            npmDepsHash = "sha256-KCx3H+oI9ueNB2rKxeb8rfpBocOnFHzR7Du3MCB4gfE=";
            npmInstallFlags = [ "--omit=dev" ];

            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/pi-audit-trail" "$out/share/pi-audit-trail/node_modules/@opencode-ai" "$out/bin"
              cp -R src "$out/share/pi-audit-trail/src"
              # The OpenCode adapter's runtime graph is the plugin tool helper
              # plus zod. Keep these beside package.json so Bun's file-plugin
              # import resolves from the immutable installed package root.
              cp -R node_modules/@opencode-ai/plugin "$out/share/pi-audit-trail/node_modules/@opencode-ai/plugin"
              cp -R node_modules/zod "$out/share/pi-audit-trail/node_modules/zod"
              find "$out/share/pi-audit-trail/src" "$out/share/pi-audit-trail/node_modules" -type f -exec chmod 444 {} +
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
