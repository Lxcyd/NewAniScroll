/**
 * La demande de source, tiree AVANT le bundle.
 *
 * Sur une arrivee franche, la page ne demandait la video qu'apres avoir
 * telecharge et execute ~360 Ko de JavaScript, hydrate React et lu les
 * preferences. Mesure a l'appui, le lecteur lui-meme ne pese qu'un cinquieme de
 * l'attente : le reste est ce chemin-la, et rien dedans n'est un travail dont
 * la requete ait besoin.
 *
 * Ce module exporte donc un script pose en clair dans le `<head>` du document
 * (cf. pages/_document.tsx). Il s'execute a l'analyse du HTML, avant tout
 * React, lit ce qu'il lui faut dans l'URL et dans `localStorage` — deux acces
 * synchrones — et lance le `fetch`. La promesse attend sur `window`, ou
 * `requestSource` vient la chercher au lieu d'en emettre une seconde.
 *
 * ── Ce qu'il ne fait pas ────────────────────────────────────────────────────
 * Il ne rejoue PAS toute la resolution du lecteur. Elle vit en TypeScript
 * (lib/prefs/animeServerPref, lib/prefs/serverPref, lib/prefs/langPref, et le
 * classement mesure de lib/watch/serverPerf) et la traduire ici en vanilla
 * serait une regle dupliquee qui derive au premier changement.
 *
 * Il ne traite que les cas SANS AMBIGUITE, ceux ou la page de lecture arrivera
 * forcement au meme lecteur que lui :
 *
 *   1. une exception memorisee pour cet anime          → ce lecteur
 *   2. un lecteur epingle dans les Reglages            → ce lecteur
 *   3. le lecteur qui a REELLEMENT joue cette serie    → ce lecteur
 *   4. l'ordre deja calcule au chargement precedent    → son premier viable
 *   5. aucun ordre de langues actif                    → DEFAULT_SERVER_ID
 *
 * Les points 3 et 4, ajoutes le 20/09/2026, sont ce qui debloque le cas
 * courant. Le script s'abstenait des qu'un ordre de langues etait regle — donc
 * presque toujours — et la requete attendait alors le bundle entier,
 * l'hydratation et deux tours d'effet.
 *
 *   3. `aniscroll:animeHost` : une OBSERVATION, pas une regle — « la derniere
 *      fois, c'est cet hote qui a rendu une image pour cette serie ». La page
 *      de lecture la consulte au meme rang (cf. `souvenir`).
 *   4. `aniscroll:earlyPick` : l'ordre que la vraie regle a produit au
 *      chargement precedent, ecrit PAR elle (cf. lib/watch/earlyPick.ts). Ce
 *      n'est pas une copie de la regle — qui deriverait — mais un cache de sa
 *      sortie, invalide des que l'ordre de langues change. Le seul filtre
 *      applique ici est celui qui depend de la SERIE : frembed, quand son
 *      catalogue est connu et ne la contient pas.
 *
 * Reste le tout premier chargement d'un appareil neuf avec ordre de langues :
 * rien n'a encore ete calcule, il s'abstient, et la page fait comme avant. Il
 * ne peut pas faire mieux sans deviner.
 *
 * Ce fichier lit donc des cles ecrites ailleurs. Leur FORME est un contrat :
 * animeHost `{aniId:{s,at}}`, earlyPick `{order,lang,at}`, frembedCatalog
 * `{ids,at}`. Les changer sans toucher ici ferait retomber le script dans son
 * abstention silencieuse — pas de panne, juste la lenteur qui revient.
 */

/** Ou la promesse attend. Un seul objet, remplace a chaque chargement. */
import { DEFAULT_SERVER_ID } from "@/lib/servers";

export const EARLY_SOURCE_KEY = "__asEarlySource";

export type EarlySource = { url: string; promise: Promise<Response> };

/**
 * Le script, en une expression immediatement appelee. Ecrit en ES5 sans
 * dependance : il tourne avant tout polyfill, et une erreur ici serait une
 * erreur AVANT la page — d'ou le `try` global et le silence complet en cas
 * d'echec. Ne rien tirer n'a aucune consequence, la page fait son travail.
 */
export const EARLY_SOURCE_SCRIPT = `(function(){try{
var m=location.pathname.match(/\\/anime\\/watch\\/(\\d+)/);if(!m)return;
var aniId=m[1];var q=new URLSearchParams(location.search);
var ep=q.get("num");if(!ep||!/^\\d+$/.test(ep))return;
var sub=q.get("dub")==="true"?"dub":"sub";var s="";
try{var a=JSON.parse(localStorage.getItem("aniscroll:animeServer")||"{}");
if(a&&typeof a==="object")s=a[aniId]||"";}catch(e){}
if(!s){try{s=localStorage.getItem("preferred_server")||"";}catch(e){}}
if(!s){try{var h=JSON.parse(localStorage.getItem("aniscroll:animeHost")||"{}");
var he=h&&h[aniId];
if(he&&he.s&&Date.now()-(he.at||0)<2592000000)s=he.s;}catch(e){}}
if(!s){var on=true,ordreBrut=null,order=null;
try{on=localStorage.getItem("lang_pref_enabled")!=="0";
ordreBrut=localStorage.getItem("lang_pref_order")||"null";
order=JSON.parse(ordreBrut);}catch(e){}
if(!on||!order||!order.length){s="${DEFAULT_SERVER_ID}";}
else{var fr=null;
try{var fc=JSON.parse(localStorage.getItem("aniscroll:frembedCatalog")||"null");
if(fc&&fc.ids&&Date.now()-(fc.at||0)<43200000)fr=fc.ids;}catch(e){}
var horsFrembed=fr&&fr.indexOf(+aniId)<0;
try{var p=JSON.parse(localStorage.getItem("aniscroll:earlyPick")||"null");
if(p&&p.lang===ordreBrut&&p.order&&p.order.length){
for(var i=0;i<p.order.length;i++){
if(horsFrembed&&p.order[i].indexOf("frembed")===0)continue;
s=p.order[i];break;}}}catch(e){}
if(!s)return;}}
var u="/api/v2/source?server="+encodeURIComponent(s)+"&aniId="+aniId+"&episode="+ep+"&sub="+sub;
window.${EARLY_SOURCE_KEY}={url:u,promise:fetch(u,{priority:"high"})};
}catch(e){}})();`;
