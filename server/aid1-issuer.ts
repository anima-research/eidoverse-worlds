// The aid1 issuer this process trusts, read once from env for both doors (server/auth.ts and mcpl/net-server.ts).
//   HN_ISSUER_KEY   pinned issuer pubkey `ed25519:…` — unset disables the door
//   HN_ISS          issuer domain            (default id.animalabs.ai)
//   HN_AUD          token audience to verify (default eidoverse; staging uses eidoverse2)
export const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
export const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
export const HN_AUD = process.env.HN_AUD ?? "eidoverse";
