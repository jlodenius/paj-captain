{ lib, stdenvNoCC, nodejs_24, util-linux }:
stdenvNoCC.mkDerivation {
  pname = "paj-captain";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.cleanSourceWith {
    src = ../.;
    filter = name: type: let
      base = builtins.baseNameOf name;
    in
      lib.cleanSourceFilter name type
      && !(builtins.elem base ["node_modules" "dist" ".cache" "result"])
      && !(lib.hasPrefix "result-" base);
  };
  nativeBuildInputs = [nodejs_24];
  nativeCheckInputs = [util-linux];
  buildPhase = ''
    runHook preBuild
    node scripts/build.ts
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test tests/*.test.js tests/*.test.ts
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/paj-captain"
    cp -r dist skills examples docs package.json README.md LICENSE "$out/share/paj-captain/"
    runHook postInstall
  '';
  meta = {
    description = "Text-first coordination of main Paj agents inside Pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
