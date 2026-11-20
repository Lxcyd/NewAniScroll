/*
 * Les polices du site, auto-hebergees (Fontsource = les memes fichiers que
 * Google Fonts, servis depuis /_next/static avec le reste du CSS).
 *
 * Avant : un `@import url(fonts.googleapis.com/...)` en tete de globals.css. Le
 * navigateur ne le decouvrait qu'APRES avoir telecharge le CSS du site, puis
 * devait ouvrir deux connexions (googleapis + gstatic) avant le premier fichier
 * de police : trois allers-retours en chaine sur le chemin du premier rendu.
 *
 * Pourquoi pas next/font : il renomme les familles (`__Karla_1a2b3c`), or les
 * noms "Karla"/"Outfit" sont ecrits en dur dans des SVG, des `ctx.font` de
 * canvas, les CSS modules de discover — et surtout dans la preference de police
 * des sous-titres que les visiteurs ont DEJA en localStorage
 * (SubtitleSettings : "Karla, sans-serif"). Fontsource garde les noms.
 *
 * La liste des graisses/styles est EXACTEMENT celle de l'ancienne URL Google :
 * en ajouter une changerait le rendu (une graisse absente se rabat aujourd'hui
 * sur la plus proche). Chaque fichier ne se telecharge que si un texte l'utilise.
 *
 * Space Grotesk / JetBrains Mono restent charges par la seule fiche anime
 * (pages/en/anime/[...id].tsx) : les declarer partout les ferait apparaitre sur
 * la page de lecture, qui s'affiche aujourd'hui avec le repli system-ui.
 */

// Karla — 200..800, droit + italique
import "@fontsource/karla/200.css";
import "@fontsource/karla/300.css";
import "@fontsource/karla/400.css";
import "@fontsource/karla/500.css";
import "@fontsource/karla/600.css";
import "@fontsource/karla/700.css";
import "@fontsource/karla/800.css";
import "@fontsource/karla/200-italic.css";
import "@fontsource/karla/300-italic.css";
import "@fontsource/karla/400-italic.css";
import "@fontsource/karla/500-italic.css";
import "@fontsource/karla/600-italic.css";
import "@fontsource/karla/700-italic.css";
import "@fontsource/karla/800-italic.css";

// Outfit — 100..900
import "@fontsource/outfit/100.css";
import "@fontsource/outfit/200.css";
import "@fontsource/outfit/300.css";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "@fontsource/outfit/800.css";
import "@fontsource/outfit/900.css";

/* Roboto et Inter : le seul sous-ensemble LATIN (20/11/2026). Leurs CSS
   complets declaraient 9 et 7 @font-face par graisse (cyrillique, grec,
   vietnamien, symboles…) : ~65 Ko de CSS pour Roboto seul, sur un site
   francais/anglais. Le fichier `latin-*` n'a pas d'unicode-range : il sert
   tous les caracteres qu'il couvre (accents francais, œ compris) et le reste
   retombe sur la police suivante. NE PAS y ajouter `latin-ext-*` a cote : sans
   unicode-range, le dernier declare l'emporterait sur tout le texte.
   Les graisses ne changent pas (cf. plus haut). */
// Roboto — 100, 300, 400, 500, 700, 900, droit + italique
import "@fontsource/roboto/latin-100.css";
import "@fontsource/roboto/latin-300.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "@fontsource/roboto/latin-900.css";
import "@fontsource/roboto/latin-100-italic.css";
import "@fontsource/roboto/latin-300-italic.css";
import "@fontsource/roboto/latin-400-italic.css";
import "@fontsource/roboto/latin-500-italic.css";
import "@fontsource/roboto/latin-700-italic.css";
import "@fontsource/roboto/latin-900-italic.css";

// Inter — 100..900
import "@fontsource/inter/latin-100.css";
import "@fontsource/inter/latin-200.css";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "@fontsource/inter/latin-900.css";

export {};
