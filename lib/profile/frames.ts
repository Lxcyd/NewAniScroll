/**
 * Les cadres d'avatar (decorations de la boutique Discord), cote navigateur ET
 * serveur.
 *
 * On ne stocke que l'`asset` Discord : l'image est servie par le CDN public de
 * Discord, qui repond sans authentification. `passthrough=true` rend l'APNG
 * ANIME (sans lui, Discord sert la premiere image figee).
 *
 * Le catalogue vit dans la table Turso `avatar_frames`, remplie chaque nuit par
 * scripts/discord-frames/sync-frames.mjs depuis itemshop.gg.
 */

export type FrameItem = { asset: string; name: string };
export type FrameCollection = { name: string; frames: FrameItem[] };

const ASSET_RE = /^(a_)?[0-9a-f]{32}$/;

/** La forme exacte d'un asset Discord — rien d'autre ne part dans une URL. */
export function isFrameAsset(v: unknown): v is string {
  return typeof v === "string" && ASSET_RE.test(v);
}

export function frameUrl(asset: string, size = 240): string {
  return `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?size=${size}&passthrough=true`;
}
