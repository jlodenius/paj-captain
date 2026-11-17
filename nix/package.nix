{ lib, stdenvNoCC, nodejs_24, util-linux }:
stdenvNoCC.mkDerivation {
  pname = "paj-captain";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.cleanSourceWith {
    src = ../.;
    filter = name: type:
      lib.cleanSourceFilter name type
      && !(builtins.elem (builtins.baseNameOf name) ["node_modules" "dist"]);
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
    node --test tests/*.test.js
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/paj-captain"
    cp -r dist skills examples package.json README.md LICENSE "$out/share/paj-captain/"
    runHook postInstall
  '';
  meta = {
    description = "Text-first coordination of main Paj agents inside Pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
