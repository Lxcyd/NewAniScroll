/**
 * La famille de domaines vidmoly, ecrite UNE fois.
 *
 * Elle existait en cinq copies litterales — l'extracteur serveur, l'extracteur
 * navigateur, le lecteur (regex du referer), et deux outils — dans deux ordres
 * differents, et la regex etait recopiee a l'identique a chaque fois. Ajouter un
 * miroir demandait donc de se souvenir de cinq endroits, et en oublier un ne se
 * voit pas : ca se traduit par un embed qui part dans le mauvais chemin
 * d'extraction, ou par un Referer envoye a un hote qui le refuse.
 *
 * Ce que ce fichier NE fait pas : imposer un ordre unique. Les deux ordres sont
 * deliberes et documentes chez leurs appelants —
 *   - serveur : les marques blanches d'abord (ansembed porte les panneaux
 *     d'anime-sama, et resiste aux listes de blocage) ;
 *   - navigateur : les vidmoly.* d'abord pour un embed vidmoly, les marques
 *     blanches en dernier recours.
 * Ce qui doit rester commun, c'est l'APPARTENANCE a la famille et la regex qui
 * la reconnait : c'est ce qu'on exporte ici, la regex etant DERIVEE de la liste
 * pour qu'elles ne puissent plus se contredire.
 */

/** Les domaines vidmoly proprement dits. */
export const VIDMOLY_CORE_DOMAINS = ["vidmoly.biz", "vidmoly.net", "vidmoly.to"];

/** Les marques blanches : meme backend, meme page d'embed, meme master.m3u8.
 *  ansembed sert les panneaux d'anime-sama, voembed le « LECTEUR myTV » de
 *  voir-anime. */
export const VIDMOLY_WHITE_LABEL_DOMAINS = ["ansembed.net", "voembed.net"];

export const VIDMOLY_ALL_DOMAINS = [
  ...VIDMOLY_WHITE_LABEL_DOMAINS,
  ...VIDMOLY_CORE_DOMAINS,
];

/** « Cette adresse appartient-elle a la famille vidmoly ? »
 *  Derivee de la liste ci-dessus : un domaine ajoute la-haut est reconnu ici
 *  sans que personne n'ait a y penser. */
export const VIDMOLY_HOST_RE = new RegExp(
  `(${VIDMOLY_ALL_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|")})`,
  "i",
);
