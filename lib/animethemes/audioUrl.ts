/**
 * L'audio seul d'un générique déjà enregistré avec son lien VIDÉO.
 *
 * Les profils choisis avant le 16/10/2026 portent `v.animethemes.moe/X.webm` :
 * une vidéo de ~45 Mo pour en jouer le son. L'OGG du même nom
 * (`a.animethemes.moe/X.ogg`) pèse ~2 Mo. Le nom ne correspond pas toujours
 * (ChainsawMan-OP1.webm → …-OP1-NCBD1080.ogg) : c'est un ESSAI, et le lecteur
 * retombe sur la vidéo d'origine si l'OGG n'existe pas (voir `onError` des
 * <audio> qui l'utilisent). Les nouveaux choix enregistrent directement le
 * lien audio donné par l'API.
 */
export function audioFirst(url: string): string {
  const m = /^https:\/\/v\.animethemes\.moe\/([^/?#]+)\.webm$/.exec(url);
  return m ? `https://a.animethemes.moe/${m[1]}.ogg` : url;
}
