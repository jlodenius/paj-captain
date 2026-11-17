{
  description = "Text-first coordination of main Paj agents inside Pi";

  outputs = {self}: {
    homeManagerModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      package = pkgs.callPackage ./nix/package.nix {};
    in {
      options.programs.paj-captain.enable = lib.mkEnableOption "Captain coordination inside Pi";

      config = lib.mkIf config.programs.paj-captain.enable {
        home.packages = [
          pkgs.tmux
          pkgs.util-linux
        ];
        home.file.".pi/agent/extensions/paj-captain".source = "${package}/share/paj-captain";
        home.file.".pi/agent/skills/paj-captain".source = "${package}/share/paj-captain/skills/paj-captain";
      };
    };
  };
}
