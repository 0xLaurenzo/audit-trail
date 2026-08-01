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
          # package.json is the single version source; manifests are
          # test-enforced against it so nothing else hardcodes the version.
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "pi-audit-trail";
            version = packageJson.version;
            src = self;
            npmDepsHash = "sha256-c3tSPyi07/MycXS46rU5oGs1v5YEBwrySSgOcD5ERRM=";
            npmInstallFlags = [ "--omit=dev" ];

            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/pi-audit-trail" "$out/share/pi-audit-trail/node_modules/@opencode-ai" "$out/bin"
              cp -R src "$out/share/pi-audit-trail/src"
              # Claude Code and Codex plugin roots: manifests and components
              # ship beside src/ so each harness can cache/link this directory.
              cp -R .claude-plugin "$out/share/pi-audit-trail/.claude-plugin"
              cp -R claude "$out/share/pi-audit-trail/claude"
              cp -R .codex-plugin "$out/share/pi-audit-trail/.codex-plugin"
              cp -R hooks "$out/share/pi-audit-trail/hooks"
              cp -R skills "$out/share/pi-audit-trail/skills"
              cp .mcp.json "$out/share/pi-audit-trail/.mcp.json"
              # The OpenCode adapter's runtime graph is the plugin tool helper
              # plus zod. Keep these beside package.json so Bun's file-plugin
              # import resolves from the immutable installed package root.
              cp -R node_modules/@opencode-ai/plugin "$out/share/pi-audit-trail/node_modules/@opencode-ai/plugin"
              cp -R node_modules/zod "$out/share/pi-audit-trail/node_modules/zod"
              find "$out/share/pi-audit-trail/src" "$out/share/pi-audit-trail/node_modules" \
                "$out/share/pi-audit-trail/.claude-plugin" "$out/share/pi-audit-trail/claude" \
                "$out/share/pi-audit-trail/.codex-plugin" "$out/share/pi-audit-trail/hooks" \
                "$out/share/pi-audit-trail/skills" "$out/share/pi-audit-trail/.mcp.json" \
                -type f -exec chmod 444 {} +
              install -Dm444 README.md "$out/share/pi-audit-trail/README.md"
              install -Dm444 package.json "$out/share/pi-audit-trail/package.json"
              cat > "$out/bin/audit-trail" <<WRAPPER
              #!${pkgs.runtimeShell}
              exec ${pkgs.nodejs_24}/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning "$out/share/pi-audit-trail/src/cli/bin.ts" "\$@"
              WRAPPER
              chmod 755 "$out/bin/audit-trail"
              # In-package launcher used by Claude/Codex hooks and MCP entries;
              # ships the pinned Node so plugins work without node on PATH.
              mkdir -p "$out/share/pi-audit-trail/bin"
              cp "$out/bin/audit-trail" "$out/share/pi-audit-trail/bin/audit-trail"
              chmod 555 "$out/share/pi-audit-trail/bin/audit-trail"
              runHook postInstall
            '';

            meta = {
              description = "Cross-harness append-only decision auditing and GitHub PR summaries";
              homepage = "https://github.com/0xLaurenzo/audit-trail";
              platforms = systems;
            };
          };
        });
    };
}
