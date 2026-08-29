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
 *   3. aucun des deux ET aucun ordre de langues actif  → megaplay, le defaut
 *
 * Reste le cas ou un ordre de langues doit trancher : la, le choix appartient
 * au code (il consulte aussi l'instantane de disponibilite et les mesures de
 * l'appareil), et tirer au juge couterait un scrape et du quota Upstash pour
 * une reponse qu'on jetterait. Dans ce cas il s'abstient, et la page fait comme
 * avant.
 *
 * Si la regle de resolution change dans les prefs, elle doit changer ici aussi.
 * C'est le prix de la duplication, assume : le gain est le plus gros poste de
 * la chaine.
 */

/** Ou la promesse attend. Un seul objet, remplace a chaque chargement. */
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
if(!s){var on=true,order=null;
try{on=localStorage.getItem("lang_pref_enabled")!=="0";
order=JSON.parse(localStorage.getItem("lang_pref_order")||"null");}catch(e){}
if(on&&order&&order.length)return;s="megaplay";}
var u="/api/v2/source?server="+encodeURIComponent(s)+"&aniId="+aniId+"&episode="+ep+"&sub="+sub;
window.${EARLY_SOURCE_KEY}={url:u,promise:fetch(u,{priority:"high"})};
}catch(e){}})();`;
