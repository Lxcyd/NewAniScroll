# DEVLOG — Lecteur video & lecteurs distants

La page de lecture : raccourcis clavier, toasts, autoplay, plein ecran,
watch2gether, et la resolution des lecteurs distants (sibnet, voir-anime,
megaplay, vidmoly...).

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

## 2026-08-17 (nuit) — Sibnet tuait la fonction, et une preference morte se rejouait a vie

Audit du reste du selecteur, apres les deux bugs de l'entree ci-dessous. Deux
trouvailles de plus, et trois choses laissees ouvertes.

**Sibnet rend un 504, systematiquement.** Mesure sur dev, 11 hotes x 3 titres
(aniId 21, 16498, 154587) : `animesama-sibnet` et `animesama-sibnet-vo` rendent
un `FUNCTION_INVOCATION_TIMEOUT` sur **6 cellules / 6**, pendant que les six
autres hotes repondent proprement. Ce n'est pas un titre difficile, c'est l'hote.

Cause : les trois jambes de `fetchSibnetEmbed` (shell.php -> worker -> page de
visionnage) sont sequentielles et plafonnees a 5 s chacune. Total 15 s —
**exactement le `maxDuration` de `/api/v2/source`**. La plateforme tuait donc la
route avant qu'elle puisse formuler la moindre reponse. Le memo
`sibnetShellBlocked` ne coupe la jambe worker que sur un 403 EXPLICITE : quand la
jambe directe **expire** (pas de reponse du tout), le memo reste faux et les
trois jambes sont payees plein tarif. C'est le cas mesure.

Un 504 est le pire resultat possible : il consomme l'invocation entiere, il
n'est pas cachable, et il n'apprend rien au client — `requestSource` le classe
`retry`, donc la sonde recommence et re-paie 15 s. Les deux chips sibnet
monopolisaient ainsi la moitie du pool de 4 pendant ~33 s : c'est une bonne
partie du « les lecteurs mettent une eternite a apparaitre ».

**Le piege du correctif** : un budget de paroi global aurait ete faux. La jambe
qui MARCHE sur un egress bloque est la **troisieme** (cf. l'entree du 08/08), et
les deux premieres consomment le budget avant elle — on aurait echange un 504
contre une regression silencieuse du seul chemin qui aboutit. Donc 5 s pour
shell.php + worker **ensemble**, et 5 s **reserves** a la page de visionnage.

Verifie sur dev apres deploiement : `504 / 15 s` -> `503 / 10-11 s` avec un corps
d'erreur structure, sur 4 cellules / 4.

**Preference de lecteur jamais validee.** `preferred_server` etait relu de
`localStorage` sans etre confronte a `lib/servers.js`. Or les ids bougent
beaucoup ici — au moins huit retires ou renommes (`animesama-vidmoly` ->
`ansembed`, `voiranime-voe`, `vidnest`, `4animo`, `miruro-jet`, les
`hianime-*`...). Un id mort donnait une cascade **permanente** : `getServer()`
retombe sur `SERVERS[0]`, donc le type reste `"api"` et la requete part quand
meme ; `/api/v2/source?server=<id mort>` echoue ; `shouldShow` ne trouve aucun
chip a marquer actif ; le repli finit par ramener megaplay. Et comme **seul un
CLIC reecrit `localStorage`**, l'id mort restait en place : le meme aller-retour
perdu et le meme flash « Source unavailable » se rejouaient a **chaque
chargement**, indefiniment. La page info payait le meme prix, en prechauffant la
preference en **priorite haute** — un scrape lourd gaspille a chaque visite.
`getServerPref()` ecarte et purge desormais un id inconnu.

### Laisse ouvert, volontairement

- **Sibnet est injoignable depuis Vercel**, 503 « embed unreachable or decoy »
  sur les trois jambes et sur toutes les cellules testees. Le correctif ci-dessus
  ne repare que la MANIERE d'echouer (proprement, en 10 s, cachable), pas
  l'acces. C'est vraisemblablement la suite de l'histoire de shards du 08/08. A
  noter : sibnet occupe encore **2 des 3 entrees** de
  `PREFERRED_FALLBACK_ORDER` — le repli privilegie donc un hote mort.
- **`degradedServers` est du plomb mort.** L'etat est calcule, passe a travers
  cinq niveaux de props jusqu'a `LangGroup`... et jamais lu. Le commentaire de
  l'etat affirme pourtant « the selector renders these red ». Un visiteur sur un
  hote degrade (repli iframe, sans notre habillage Vidstack) n'a aucun signal.
- **L'effet « appliquer la preference une fois confirmee »** (`[...info].js`,
  juste sous l'effet de montage) est **injoignable dans tous les cas** : l'effet
  de montage pose `appliedPrefRef.current = true` des qu'une preference existe,
  et l'autre branche sort sur `!pref`. Son commentaire decrit un comportement
  qui n'a plus lieu — exactement le genre de chose qui egare la prochaine
  session de debug.

**La lecon** : le budget d'une cascade de replis doit etre compare au
`maxDuration` de la fonction qui l'heberge. Ici la somme des replis EGALAIT la
limite, donc le chemin « tout echoue » — le plus frequent sur un hote en panne —
etait le seul a ne jamais pouvoir repondre.

## 2026-08-17 (soir) — Les chips s'effacent tous, et Megaplay ne revient jamais

Deux bugs sans rapport l'un avec l'autre, tous deux dans le selecteur de
serveurs, tous deux des **decalages de cle** entre deux effets qui doivent
pourtant vivre au meme rythme.

**Bug 1 — tous les chips disparaissent sauf l'actif.** La remise a zero de
`confirmedServers` / `failedServers` / `degradedServers` vivait en tete de
l'effet « liste d'episodes », dont les deps sont
`[sessions?.user?.name, epiNumber, dub, info?.id]`. Le nom arrive en asynchrone
(`useSession()` rend `undefined` puis l'objet session) et next-auth refetch au
focus de la fenetre : la remise a zero se rejouait donc **sur un episode
parfaitement stable**. L'effet de sondage, lui, n'est cle que sur
`[info?.id, epiNumber, dub]` et ne se rejouait pas — son `cachedConfirmed` en
memoire retenait deja tous les serveurs, donc chaque `probe()` sortait a la
premiere ligne et **rien ne se repeignait jamais**.

Ce qui rend le symptome total plutot que partiel : depuis la retraite des
lecteurs iframe, **les 11 serveurs de `lib/servers.js` sont tous `type: "api"`**.
La ligne `if (server.type === "iframe") return true;` de `shouldShow` est donc
morte, et chaque chip depend uniquement de `confirmedServers.has(id)`. Un Set
vide efface le selecteur entier ; seul l'actif survit, par la premiere ligne de
`shouldShow`. L'aleatoire (« parfois ») etait la course entre l'hydratation de
la session et la fin du pool de sondes.

**Bug 2 — Megaplay absent alors que la video existe.** Le fan-out retire le
serveur actif du pool, au motif que `fetchStreamSource` le resout deja et
allume son chip. Mais il lisait l'`activeServer` **fige dans la closure** de
l'effet — c'est-a-dire toujours `"megaplay"`, le placeholder SSR, puisque
l'effet part au montage, avant que la preference sauvegardee soit lue. Pour
quiconque a une preference **autre que megaplay**, megaplay etait donc saute
par le pool *et* jamais demande par le chemin actif (qui, lui, va chercher la
preference). Son chip ne pouvait structurellement pas apparaitre. Corrige en
lisant un `activeServerRef` au moment du splice — apres les `await`, donc une
fois la preference posee.

**Verifie que le backend n'y est pour rien** :
`/api/v2/source?server=megaplay&aniId=21&episode=1&sub=sub` rend un
`master.m3u8` valide sur dev. Le meme appel confirme au passage que
`voiranime-vidmoly` repond `{"absent":true,"hard":true}` et
`animesama-sibnet-vo` un 503 « embed unreachable or decoy » sur ce titre.

**La lecon** : deux effets qui pilotent le meme etat doivent porter la **meme
cle**. Ici l'un se remettait a zero sur un evenement que l'autre ignorait, et
la reparation (re-sonder) etait justement ce que l'autre refusait de faire.
Meme famille que le bug de l'observateur de boutons juste en dessous : dans les
deux cas, un effet garde une valeur figee pendant qu'un autre avance.

**Non verifie en navigateur au moment d'ecrire** : `tsc` passe, le
raisonnement est verifie contre le code et le backend, mais le comportement
doit etre constate sur dev.aniscroll.com.

## 2026-08-17 — Changer de lecteur faisait disparaitre nos boutons

**Symptome** : en quittant Uqload pour un autre lecteur, il manque des boutons
dans la barre. La roue crantee et le PiP restent — ce sont ceux de Vidstack —
mais le plein ecran, l'episode suivant et le groupe telechargement/sous-titres/
cast disparaissent jusqu'a un rechargement complet de la page.

**Cause** : ce sont exactement les boutons que nous **portalons** dans la barre
de Vidstack, via quatre `div` hotes qu'un `MutationObserver` va replacer a
chaque fois que Vidstack reconstruit son sous-arbre. L'observateur etait cree
dans un `useEffect` dont les dependances etaient `[isSmallLayout]` seul, et sa
callback etait `() => sync(playerEl)` — `playerEl` etant le noeud **capture au
moment du setup**.

Or un changement de serveur vide `streamData`, donc le rendu tombe dans le
retour anticipe « loading » / « Source unavailable » plus bas dans le fichier,
et **`<MediaPlayer>` est demonte**. Le flux suivant en remonte un neuf. L'effet,
lui, ne se rejouait pas : l'observateur restait accroche a l'element mort. Pire
qu'un simple no-op — l'observateur du `document.body` (`subtree: true`)
continuait de tiquer, `sync` s'executait sur un orphelin, tous les
`querySelector` rendaient des noeuds deconnectes, et chaque hote etait donc
**activement detache** avec son drapeau remis a `false`.

**Pourquoi Uqload le declenche a tous les coups** : classe dernier (`speed: 5`),
jeton lie a l'IP et a usage unique, une extraction lente et qui echoue souvent.
Le retour anticipe a donc toujours le temps de rendre. Le bug n'est pas propre a
Uqload — n'importe quel changement de serveur peut le produire — mais c'est avec
lui qu'il est systematique.

**Correction** : ajouter `playerElState` aux dependances de l'effet (l'etat qui
suit deja la racine du player, rafraichi sur `[streamData]`), et relire la
racine vivante dans la callback plutot que de syncer le noeud capture.

**La lecon** : `playerElState` existait deja et **tous** les autres effets qui
touchent la racine du player en dependaient (le miroir `data-fullscreen`, le
double-clic, les raccourcis). Le localisateur etait la seule exception. Quand un
fichier a une convention aussi nette, l'endroit qui s'en ecarte est le suspect a
regarder en premier.

**Non verifie en navigateur au moment d'ecrire** : `tsc` passe, mais le
comportement doit etre constate sur dev.aniscroll.com (localhost ne reproduit
pas les conditions de resolution des lecteurs).

## 2026-08-08 (soir) — Sibnet remarche : deux blocages, et une conclusion fausse en route

Suite du diagnostic du lot `top50` ci-dessous. Sibnet ne rendait que 5 cellules
sur 439 alors qu'anime-sama le propose sur 89 % des saisons. Corrige (commit
2c5e027, `lib/extractors.js`) — et **la production n'a jamais ete concernee**.

**⚠️ Ma conclusion intermediaire etait fausse, et Luc l'a corrigee.** J'avais
ecrit que Vercel et Cloudflare etaient bloques comme la ligne de Luc, sur la foi
d'un `{"absent":true}` renvoye par dev pour SnK ep5. C'etait un episode sans
upload sibnet, pas un blocage : l'ep11 rend un flux normal depuis Vercel. La
lecon est petite et couteuse — **ne jamais declarer un hote mort sur un
environnement a partir d'un seul episode**, la ou l'absence est un resultat
attendu la moitie du temps. Seules la ligne residentielle de Luc et Cloudflare
sont filtrees ; un VPN ouest-europeen passe, donc c'est un filtre d'IP/plage
FAI, pas un geo-blocage.

**Blocage 1 — l'endpoint d'embed.** `shell.php?videoid=` repond 403, sur *tous*
les videoid, y compris un identifiant inexistant : c'est l'endpoint qui est
ferme, pas les videos. La page de visionnage `/video<ID>`, elle, repond 200 et
porte le meme `player.src`. On la lit en dernier recours. `looksGood` valide
toujours le videoid, donc la porte de secours ne laisse pas passer de leurre.

**Blocage 2 — le shard CDN, et c'est le vrai enseignement.** Le 302 route chaque
client vers un shard, et certains shards refusent certains reseaux : depuis la
ligne de Luc toute redirection tombe sur `dv97`, qui refuse ; Vercel est route
vers `cvs111-2`, qui sert. **La signature n'est pas liee au hostname** — mesure
sur deux fichiers et deux machines, une requete `st`/`e`/`stor` identique a
servi un 206 depuis `cvs111-2` et un 400 depuis `dv97`. Un shard qui dit non
vaut donc la peine d'etre rejoue ailleurs, tel quel.

**Le piege qui a fait echouer le premier correctif.** Le repli ne se declenchait
jamais. Raison : **un shard qui refuse ne refuse pas vite, il PEND**. Avec
`redirect: "follow"`, la requete mourait sur le timeout d'abort *sans objet
reponse*, donc on n'apprenait jamais quel shard reessayer. D'ou la resolution du
302 en deux temps (`redirect: "manual"`), qui lit le `Location` avant de
s'engager. Deuxieme piege du meme correctif : le Referer du hop doit etre la
page **reellement lue** — envoyer un Referer `shell.php` pour une page qu'on n'a
jamais obtenue fait repondre 403 au lieu de rediriger.

Verifie depuis la machine bloquee : 3/3 episodes resolus ET lus (206, 64 Ko), et
`bridge/resolve_sibnet.mjs` rend `ok:true` sur SnK 1-3.

**Effet attendu sur le detecteur** : sibnet redevient un second temoin sur ~89 %
des saisons, et **53 % des cellules retenues (76/144) le sont faute d'un
deuxieme hote**. C'est le levier principal, pas un gain marginal.

**Corollaire livre au passage** (commit 5dd0306) : un extracteur qui n'a jamais
atteint la page ne sait rien de l'episode, et ne doit donc pas publier une
absence que le client met en cache 6 h. `extractSibnet` marque desormais
`transient: true` dans ce cas, et le resolveur leve une `TransientSourceError`
-> 503 -> la puce lit `retry`. Une absence de preuve n'est pas une preuve
d'absence.

---


## 2026-08-06 — Le cache de sondes n'etait pas indexe par EPISODE

Suite du precedent. Le repli marche (ep2 VF bascule bien sur Anime-Sama Sibnet,
en VF), mais Luc : « il y est toujours, quand je passe de l'ep 1 [ou il existe] a
l'ep 2 ». Le chip Voir-Anime restait VERT sur un episode dont l'upload est mort.

### La cle oubliait l'episode
```js
// avant
const probeCacheKey = `aniscroll.probes.${info.id}.${dub ? "dub" : "sub"}`;
```
Cache sessionStorage, TTL 90 s, sur la premisse ecrite en commentaire : « d'un
episode a l'autre la disponibilite change a peine ». Vrai de la presence au
catalogue, **faux des uploads**, qui meurent un episode a la fois. Les
confirmations de l'ep 1 etaient donc rehydratees sur l'ep 2 — chip vert pour une
source inexistante, et surtout entree dans `cachedConfirmed`, ce qui fait SAUTER
la sonde qui l'aurait detectee. Tous les autres stocks de disponibilite de la
page sont indexes par episode (snapshot Redis `avail:v1:<id>:<ep>:<sub>`, cache
negatif, cache de source) : celui-la etait le seul a ne pas l'etre.

Le pre-affichage inter-episodes n'est pas perdu : le snapshot inter-visiteurs,
lui aussi par episode, allume deja les chips au premier rendu.

### Asymetrie restante (non corrigee, assumee)
Un `ok` du snapshot est TRUSTED et jamais re-sonde pendant 6 h (c'est le gain CPU
assume de juillet), alors qu'un `absent` est re-sonde sur ~20 % des visites. Un
hote mort entre-temps reste donc vert jusqu'a ce que quelqu'un le SELECTIONNE —
la, le chemin clic le rabat (et, depuis `hard`, publie l'absence pour tous).
Symetriser couterait exactement le trafic Upstash que ce gain protege : a
arbitrer avec Luc, pas a decider seul.

## 2026-08-06 — Un upload mort ne doit pas revenir a chaque rechargement

Luc, ep 2 VF de Clevatess S2 (aniId 198946) : « le lecteur vf est mort et a
chaque fois que je reload il reapparait ». Mesure sur voir-anime :

```
clevatess-2-vf  ep1  voembed.net/embed-giegiymmyrta   HEAD 200  m3u8=true
clevatess-2-vf  ep2  voembed.net/embed-3mx1x85hof1b   HEAD 404  <-- upload supprime
clevatess-2-vf  ep3  voembed.net/embed-d92n983p22by   HEAD 200  m3u8=true
```

L'API repond donc `absent` a juste titre. **Le bug est ce que le lecteur en
fait.** Deux comportements, tous deux volontaires, tous deux faux ici :

1. Le chemin « clic » retente 3 fois (800/1600/3200 ms) avant de conclure, parce
   qu'un hote peut servir un leurre anti-bot a froid. Sur un 404 prouve c'est
   5,6 s de roue qui tourne pour rien — la « mort » du lecteur.
2. Il refuse ensuite de PUBLIER l'absence (un leurre et un vrai vide se
   ressemblent, et se tromper masque un hote sain 6 h). Donc le chip n'est jamais
   masque : il revient a chaque rechargement, mort a chaque fois.

### Le manque : une absence prouvee n'avait pas de nom
`isVidmolyEmbedAlive` ne renvoie `false` que sur un 404 explicite (une erreur
reseau renvoie `true`, on ne punit jamais un chip pour notre propre hoquet). On
SAIT donc que l'upload est supprime — mais l'info se perdait dans un `null`
indistinguable d'un « pas trouve ». Ajout de `HardAbsenceError`, symetrique de
`TransientSourceError` : le contrat a maintenant trois etats au lieu de deux.

| Verdict | Sens | Effet |
|---|---|---|
| `TransientSourceError` | l'amont a hoquete | 503, on retente, rien n'est enterre |
| `null` | pas trouve (ambigu) | 404, cache 10 min, publie par la sonde de fond seulement |
| `HardAbsenceError` | **prouve** (404 de l'hote) | 404 + `{absent, hard}` : pas de retry, chip masque |

Le drapeau traverse tout le chemin, cache compris (`HARD_NOT_FOUND_SENTINEL`) —
sinon il n'aurait survecu qu'a une requete sur 10 minutes.

### Au passage : le repli changeait de langue
`PREFERRED_FALLBACK_ORDER` listait 9 serveurs dont **6 n'existent plus** dans
lib/servers.js (hianime-*, animesama-oneupload, voiranime-streamtape*).
`isCandidate` les filtrait en silence, la liste valait donc
`[megaplay, animesama-sibnet, animesama-sibnet-vo]`. Et comme le test acceptait
`lang === "multi"` au meme rang, perdre un chip VF basculait l'episode sur
Megaplay — donc en VOSTFR. Repli en deux temps : meme langue STRICTE d'abord
(liste indicative puis lib/servers.js, deja triee par vitesse), le reste apres.

### Leçons / pièges
- **« Le lecteur est mort » et « le chip revient » etaient le meme bug**, vu par
  ses deux bouts : le retry qui fait attendre, le non-publie qui fait revenir.
- **Un garde-fou anti-leurre applique sans nuance devient une panne** : les 3
  retries et le refus de publier sont justes pour une absence ambigue, absurdes
  pour un 404 prouve. Il manquait la distinction, pas la prudence.
- **Risque assume** : si vidmoly se mettait a 404 des slugs valides depuis les IP
  Vercel, on publierait desormais une absence de 6 h depuis le chemin clic. La
  sonde de fond publiait deja sur ce meme signal — le profil de risque ne change
  pas, seul le chemin s'aligne.
- **Verifier l'amont avant d'accuser le code** : ici les trois episodes voisins
  prouvaient en une commande que le probleme etait l'upload, pas la resolution.

## 2026-08-06 — Le chip Voir-Anime disparait au rechargement (absence fabriquee)

Luc : deux captures de Clevatess S2 (aniId 198946) sur dev, meme page. Avant
rechargement le chip « Voir-Anime Vidmoly » est la, en vert ; apres, la ligne VF
n'a plus que les trois anime-sama. Ma premiere hypothese (le snapshot 6h masque
au premier rendu) etait dans le mauvais sens : ici le chip est present PUIS perdu.

### La cause : `getVoiranimeIframe` renvoyait `null` pour TOUT
Le contrat du routeur ([pages/api/v2/source/index.js](pages/api/v2/source/index.js)) :
`null` = « cet hote n'a genuinement pas cet episode » → 404 + cache negatif 10 min
+ publication dans le snapshot de disponibilite **6 h** ; `TransientSourceError` =
« l'amont a hoquete » → 503, le client retente, rien n'est enterre.

anime-sama respecte ce contrat (son `catch` rethrow en transitoire, sa page detail
non-200 leve). **voir-anime ne l'a jamais respecte** : `catch (e) { return null }`,
page episode non-200 → `null`, `thisChapterSources` absent → `null`, recherche de
slug non concluante → `null`. Donc un seul 429 du Worker, un challenge Cloudflare
ou un timeout se diffusait comme une absence definitive — pour TOUS les visiteurs,
pendant 6 h. C'est mot pour mot le bug « megaplay disparait apres un rechargement »
deja documente dans ce fichier, sur un autre fournisseur.

Mesure : a froid l'appel met **2065 ms** (worker + page detail + page episode +
sonde HEAD), contre ~100 ms en cache. La marge avant timeout est mince — d'ou le
caractere intermittent, et d'ou le fait que ca s'est vu maintenant : la migration
voembed a rallonge le chemin (une famille de domaines de plus a essayer).

### Correctif : classer les echecs au lieu de tous les aplatir
- page episode 5xx/429/403 → transitoire ; un vrai 404/410 reste une absence.
- `thisChapterSources` absent ou illisible sur un 200 → transitoire (c'est une
  interstitielle anti-bot, pas une page sans lecteur).
- page detail 5xx/429/timeout + fallback AJAX vide → transitoire (`detailInconclusive`).
- recherche de slug non concluante → transitoire. Le flag `sawInconclusive`
  existait deja et protegeait le cache memoire, mais le VERDICT sortait quand
  meme en `null` — la moitie du garde-fou manquait.
- `catch` final → rethrow en `TransientSourceError`, comme anime-sama.

Seul reste `null` : la page a bien ete lue et l'hote n'y est pas (le cas
vidmoly/voembed d'hier), ou l'upload est mort (HEAD 404).

### Leçons / pièges
- **Une capture « avant/apres » donne le SENS de la panne** : chip present puis
  absent = une absence ecrite pendant la session ; absent puis present = un cache
  d'affichage perime. J'avais decrit le second, Luc observait le premier.
- **Un contrat null/throw ne vaut que si chaque fournisseur l'honore.** Le meme
  bug a ete corrige sur megaplay, puis re-introduit ailleurs par simple omission —
  rien dans le code ne l'imposait a voir-anime. Le commentaire de `sendRetryable`
  decrit pourtant exactement le piege.
- **Ne pas conclure depuis une seule sonde qui passe** : au moment du diagnostic
  l'API repondait 200 sur les 3 tours. C'est le CHEMIN de code, pas la mesure
  instantanee, qui prouve le bug.

## 2026-08-06 — voir-anime migre « LECTEUR myTV » : vidmoly.biz -> voembed.net

Luc signale que certains lecteurs vidmoly de voir-anime ont change. Mesure sur
les pages live : le panneau **LECTEUR myTV** sert desormais `voembed.net` sur les
titres recents, `vidmoly.biz` sur le back-catalogue.

- 25 episodes lies depuis la home : **25/25 sur voembed.net**, 0 vidmoly.
- 25 slugs `player_map` verifies tires au hasard (VF) : **24/25 encore sur
  vidmoly.biz**, 1 deja migre (`sousou-no-frieren-2-vf`).

Notre filtre d'hote ne connaissait que `vidmoly.(to|biz|net)` : sur un titre
migre aucun panneau ne matchait, donc **le chip Voir-Anime disparaissait
entierement** (pas « casse » : absent, comme le split Re:Zero de la veille).

### C'est un white-label vidmoly, pas un nouvel hote
La page embed voembed est une page vidmoly : `<meta description>` « VidMoly »,
favicon `vidmoly.me`, assets `cdn.staticmoly.me`, meme `…/hls2/…/master.m3u8`.
Le slug resout AUSSI sur `vidmoly.biz/.net` et `ansembed.net` (verifie) — donc
espace de noms partage, contrairement a ansembed. Ajoute a la famille
(`VIDMOLY_DOMAINS` / `VIDMOLY_HOST_RE`) plutot que traite comme un hote a part :
meme backend, meme encode, donc **meme hote de fingerprint OP/ED `vidmoly-va`**,
aucun ajout dans `lib/hostRegistry.js` ni dans `lib/servers.js` (le chip
« Voir-Anime Vidmoly » est inchange, il resout juste a nouveau).

Touche : [lib/extractors.js](lib/extractors.js), [lib/clientVidmoly.js](lib/clientVidmoly.js),
[pages/api/v2/source/index.js](pages/api/v2/source/index.js) (hotes du panneau,
sonde d'aliveness, `EXTRACTABLE_HOSTS`),
[components/watch/primary/UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx)
(`referrerPolicy` no-referrer, qui ne couvrait ni ansembed ni voembed),
[tools/opening-detector/bridge/resolve.mjs](tools/opening-detector/bridge/resolve.mjs).

### Leçons / pièges
- **La sonde d'aliveness ne doit pas reecrire le domaine** d'un white-label :
  `embedUrl.replace(/vidmoly\.(to|biz|net)/, "vidmoly.biz")` sur une URL voembed
  ne matche rien, mais le reflexe inverse (forcer .biz) 404erait sur un slug qui
  n'y est pas. On sonde l'hote d'origine, comme pour ansembed.
- **Verifie de bout en bout** (page episode -> panneau -> HEAD -> m3u8 -> GET du
  master) sur 3 titres migres : master 200 `#EXTM3U`. Un slug vidmoly.biz mort
  (Naruto ep1) reste correctement masque : HEAD 404 == GET 404.
- **Ne pas generaliser depuis la home** : elle ne montre que les sorties recentes.
  C'est le croisement home (100 % voembed) x `player_map` (96 % vidmoly) qui
  donne la vraie image — une migration en cours, les deux hotes doivent matcher.
- Les autres panneaux voir-anime (MOON = miroirs VOE, Stape, FHD1 = mail.ru, YU,
  SB = streamhide) restent non branches : signales a Luc, pas demandes.

## 2026-08-06 — Episode SPLIT par le lecteur : Re:Zero ep1 VF (01a + 01b -> 49 min)

L'inverse du multi-parties de la veille. Hier : un fichier = plusieurs episodes
(`oped/multipart.py`). Aujourd'hui : plusieurs fichiers = UN episode. voir-anime
decoupe la premiere VF de Re:Zero en `…-01a-vf/` (25:07) et `…-01b-vf/` (24:07),
la VOSTFR non. Luc : « c'est une exception, ce sera le seul ».

### Le chip n'etait pas casse, il etait ABSENT
`buildVoiranimeEpRegex` ancre sur `-<chiffres>` juste avant le slash final, donc
`01a` ne matche jamais. Mesure sur la page live : episodes trouves = **2..25**.
L'episode 1 VF n'a jamais resolu, sur aucun lecteur. Cette invisibilite est aussi
la garantie qu'on garde : aucun autre titre ne peut ramasser une page `-a`/`-b`
par accident, seuls les appelants qui ont consulte la table opt-in les cherchent.

### Table d'exceptions, pas de regle generique (`lib/multipartEpisodes.js`)
Accepter `01a`/`01b` partout recollerait des episodes legitimement separes
ailleurs (specials, recaps, cours splittes). Recoller deux episodes sans rapport
est bien pire que d'en rater un : ca corrompt la timeline, la reprise et chaque
timing OP/ED qui en derive. Une entree = un opt-in a la main.

### Fusion au niveau PLAYLIST, pas dans le lecteur (`lib/hlsMerge.js`)
Le choix structurant. On concatene les playlists HLS (`#EXT-X-DISCONTINUITY`
entre les deux) et on sert un blob: unique. En dessous de `<MediaPlayer>` il n'y
a **rien a savoir** : scrubber, seek, progression, overlay skip voient un fichier
VOD ordinaire de 49 min. L'alternative (enchainement + timeline virtuelle)
obligeait a patcher barre, seek, HoverPreview, VideoStats, progress.ts, download.
L'ABR survit : les variantes sont appariees rang par rang (1080p avec 1080p) et
un master synthetique les liste toutes.

### Le piege : ffmpeg et hls.js ne lisent PAS la meme discontinuite
La playlist fusionnee marche pour le navigateur mais **pas** pour le detecteur.
Le demuxer HLS de ffmpeg ne rebase pas les timestamps de la partie B — mesure sur
les vrais flux :

    playlist fusionnee + EXT-X-DISCONTINUITY   -ss 1600 / 2000 / 2900 -> 0 octet
    .ffconcat + `duration` par entree          -ss 1600 / 2000 / 2900 -> fenetre pleine

Donc deux representations du meme episode : m3u8 fusionne pour le navigateur,
`.ffconcat` pour le bridge. Les directives `duration` sont porteuses deux fois :
sans elles la duree totale est `N/A` et `-sseof` (l'ancrage de la fenetre ED)
ne rend **rien du tout**, silencieusement.

### Deux options ffmpeg qui tuent selon la forme de l'entree
- `-headers` appartient au protocole http. Sur une entree LOCALE ffmpeg la
  resout contre le protocole file, ne trouve rien et abandonne avant d'ouvrir
  le fichier (« Option headers not found »). megaplay contournait deja ca en
  mettant `referer = None` a la main ; c'est generalise (`_input_headers`).
  Verifie au passage : les segments Vidmoly n'ont pas besoin du Referer, le
  token est lie a l'IP.
- Les flags HLS (`-allowed_extensions` …) sont fatals pour le demuxer concat
  (« Option allowed_extensions not found »). D'ou `_hls_flags` en soit/soit,
  partage par audio.py, video_fingerprint.py et detect_anime.py — les trois
  dupliquaient le meme bloc.

### Mesures de bout en bout
- parties trouvees et ordonnees sur la page live : 01a puis 01b
- bridge : `2 parts -> 2954s (1507 + 1447)` = 49:14, la duree de la VOSTFR
- ffprobe a travers le .ffconcat : 2954.106 s ; `multipart.py` en deduit **2 parties**
- fenetres decodees : OP 240 s, partie B 30 s, ED `-sseof -180` 180 s (pleines)
- variantes preservees : 1080p + 480p

Non verifie ici : la lecture navigateur (memoire `no-local-player-testing` — il
faut un vrai flux, donc dev.aniscroll.com). C'est hls.js qui doit avaler la
discontinuite, ce pour quoi la balise existe, mais ca reste a constater.

## 2026-07-30 (suite 2) — Bouton "épisode suivant" dans la barre + on RESTE en plein écran au changement d'épisode

Deux demandes liées. Le bouton est trivial ; garder le plein écran l'était moins.

**Bouton next (icône `skip_next` classique) dans la barre de contrôle.** Même technique que Download/Subs/Cast : un **host DOM stable** (`data-slot="moopa-nav-controls-host"`, `display:contents`) dans lequel React portale le bouton, que le MutationObserver **repositionne** juste après le bouton play. Piège évité : le host des boutons custom se place dans le **dernier** `.vds-controls-group` — ce qui marche en layout large mais PAS en `data-size="sm"`, où le dernier groupe est la **barre de progression** (l'ordre mobile est : [cc/menus/mute] · [play centré] · [temps+fullscreen] · [slider]). Le nouveau host cible donc le groupe **par contenu** (celui qui contient `.vds-play-button`), valable sur les deux layouts. En mobile ce groupe est `pointer-events:none` (seul le play réactive) et le play y est rond/40px/`translateY(25%)` → CSS dédiée pour que le bouton next soit cliquable et assorti.

**Rester en plein écran (le vrai sujet).** Le player est **keyé** par `{server}-{aniId}-{episode}-{sub|dub}` → changer d'épisode **démonte** `.vds-player`, et l'API Fullscreen lâche le plein écran dès que son élément quitte le DOM. L'ancien code assumait la sortie (SkipOverlay faisait un `exitFullscreen()` explicite avant `router.push`, sinon la page suivante chargeait *sous* une frame figée et le bouton semblait mort).

Fix = **handoff en 2 temps** autour de la navigation (`lib/player/episodeTransition.ts`) :
1. `beginEpisodeTransition()` (dans le geste, **avant** `router.push`, et **await** pour ne pas courir contre le démontage) donne le plein écran à un **host de niveau `_app`** (`components/shared/episodeTransitionOverlay.tsx`) qui survit à toute navigation. Il peint du noir + **la barre rose du site** (le `<NextNProgress>` de la page est invisible quand un autre élément possède l'écran) → l'utilisateur voit que ça charge.
2. `claimEpisodeTransition(el)` : le **nouveau** player récupère le plein écran dès que son élément existe (le plus tôt possible = geste encore récent → activation transitoire probablement encore valide).

**Pourquoi rendre le plein écran à `.vds-player` et pas garder un ancêtre plein écran** (ce qui aurait évité le 2ᵉ `requestFullscreen`) : Vidstack dérive son état de `isFullscreen(player.el)` = `fullscreenElement === el || el.matches(':fullscreen')`, et `:fullscreen` ne matche **QUE** l'élément demandé (pas ses descendants — la remontée du spec est inter-**documents**/iframes, pas inter-éléments). Un ancêtre plein écran laisserait donc Vidstack en état "fenêtré" → mauvaise icône, `[data-fullscreen]` absent (ratio 16:9 gardé → bandes noires) et surtout **menus portalisés vers `<body>`** donc invisibles en plein écran mobile. Vérifié aussi dans le dist Vidstack : son `FullscreenController.exit()` (appelé au dispose du player) **court-circuite** si son élément n'est pas l'élément plein écran → le démontage de l'ancien player ne casse pas notre handoff. 

### Le vrai verdict (2ᵉ test user) : **le handoff par re-demande est IMPOSSIBLE** → refonte, le plein écran passe sur `<html>`

Trace `?fsdebug` du user, sans ambiguïté :
```
begin: host owns the screen          ← étape 1 OK
claim → Failed to execute 'requestFullscreen' on 'Element':
        API can only be initiated by a user gesture.
```
Donc **Chrome exige une activation utilisateur pour re-demander le plein écran**, même document déjà en plein écran (mon hypothèse "déjà fullscreen ⇒ autorisé" était fausse). Et de toute façon l'activation transitoire (~5 s) est expirée quand la source du nouvel épisode finit de se résoudre.

**Nuance découverte en testant le mécanisme dans un vrai Chrome** (script Playwright + Chrome système, `scratchpad/fs-mechanism.html`) : une re-demande **sans geste est accordée si la cible est un DESCENDANT** de l'élément plein écran courant (plein écran imbriqué), et refusée sinon. Mon host vivait dans `_app`, donc **frère** du player, pas ancêtre → refus. C'est exactement ce que la console montrait.

**Refonte (design final).** L'élément plein écran doit être **stable depuis le début** : c'est `document.documentElement`, qu'aucune navigation ne démonte → **plus jamais de re-demande**. Le "player en plein écran" devient du **CSS** (`aniscroll-player-fs` : `position:fixed; inset:0; z-index:9999`) — c'est-à-dire le pseudo-fullscreen déjà éprouvé pour iOS, **généralisé à toutes les plateformes**, avec le vrai plein écran racine par-dessus pour faire disparaître la chrome du navigateur. Mesuré en vrai Chrome : démonter/remonter l'enfant **ne perd pas** `document.fullscreenElement` (= HTML). Nouveau module `lib/player/playerFullscreen.ts` (état hors React pour survivre au remount + `usePlayerFullscreen`), `episodeTransition.ts` réduit à l'overlay de chargement (plus aucun appel Fullscreen).

**Pourquoi la racine et pas un wrapper ancêtre du player** (les deux résolvent la persistance) : quand Vidstack ne se croit pas en plein écran, il **portalise ses menus vers `<body>`** sur layout mobile (`<Portal disabled="fullscreen">` — le portal n'est désactivé QUE s'il se croit fullscreen). Avec un wrapper ancêtre, `<body>` est **hors** du sous-arbre plein écran → menus invisibles en plein écran mobile. Avec `<html>` comme élément plein écran, tout le document est dedans → les menus s'affichent (leur `z-index:9999999` passe au-dessus de notre wrapper à 9999). C'est ce détail qui a tranché entre les deux.

**Le prix à payer, assumé et compensé** : l'état `fullscreen` de Vidstack reste faux. Donc (1) on **cache son bouton plein écran** (son icône/label viennent de son état → il afficherait "Entrer en plein écran" *en* plein écran) et on portale **le nôtre** juste après, ancré sur le bouton natif resté dans le DOM ; (2) on **pose `data-fullscreen` à la main** sur la racine du player → toutes les règles `[data-fullscreen]` existantes (thème Vidstack **et** nos globals : rayon, ratio, taille des boutons, échelle des sous-titres) continuent de marcher (Vidstack n'écrit cet attribut que sur changement de son état, qui n'arrive plus → il ne nous le reprend pas) ; (3) le geste **double-clic** `toggle:fullscreen` de Vidstack est **intercepté** en capture (il entrerait dans SON plein écran, que le changement d'épisode retuerait). `keyDisabled` fait que son raccourci `f` n'existe pas, donc pas d'autre porte d'entrée. Bonus : le pseudo-fullscreen iOS n'est plus un cas spécial, et le verrou d'orientation/scroll est étendu à tout appareil tactile.

**Dernier bug (3ᵉ test user) : "le 1er next marche, le 2ᵉ sort du plein écran".** Le relâchement du mode était branché sur le **démontage de UniversalPlayer** (gardé par "sauf si une transition est en cours"). Or le player est remonté **bien plus souvent** que "l'utilisateur est parti" : sa clé est `{serveur}-{aniId}-{épisode}-{dub}`, donc il remonte aussi sur un **repli de serveur** (l'épisode testé avait un flux en 403) et pendant un battement quand le **numéro d'épisode du router arrive avant les données du stream**. Ces remounts arrivent *après* le claim (donc `pending=false`) → le garde-fou les laissait relâcher l'écran. **Fix : c'est la PAGE watch qui relâche** (`useEffect(() => () => setPlayerFullscreen(false), [])`) — elle reste montée sur toute la route (tous les changements d'épisode) et ne se démonte qu'en partant vraiment. Plus aucun remount, dans aucun ordre, ne peut tuer le plein écran. **Leçon : ne pas confondre "le composant se démonte" et "l'utilisateur s'en va"** — sur une page dont un enfant est keyé, le démontage de l'enfant est un signal de *reconstruction*, pas de sortie.

**Validation (vrai Chrome, sur le preview déployé, pas en local)** : Playwright + Chrome système, clic réel sur notre bouton plein écran puis 3 `next` d'affilée → `document.fullscreenElement === HTML`, classe CSS et `data-fullscreen` présents, label "Quitter le plein écran", épisodes 1→2→3→4, zéro erreur console. Script : `scratchpad/live-test2.mjs` (le local ne résout pas les sources : inutile d'y tester le player).

**Leçon (la vraie) : ne jamais bâtir une feature sur un `requestFullscreen` qu'on ne peut pas garantir.** L'API n'est utilisable qu'au moment du geste ; tout ce qui doit survivre à une navigation doit être plein écran **avant** de naviguer, sur un élément que rien ne démonte.

**Bug intermédiaire — "sorti du plein écran de force" (1ère correction, gardée pour la leçon).** Cause : **changer d'élément plein écran n'est pas atomique**. Quand on demande le plein écran pour le host alors que `.vds-player` l'a, le navigateur **sort d'abord** (`fullscreenchange` avec `fullscreenElement === null`) **puis entre** sur le host (2ᵉ `fullscreenchange`). Ma détection d'Échap prenait le null intermédiaire pour un abandon utilisateur → `cancel()` → host repassé en `display:none` **alors qu'il devenait l'élément plein écran** → puis le garde-fou "host obsolète" voyait `fullscreenElement === host` avec `pending=false` → `exitFs()` → **sortie forcée**. Trois correctifs : (1) flag `swapping` posé autour de NOS `requestFullscreen` — on ignore tout `fullscreenchange` pendant un swap qu'on a initié, le verdict vient de la promesse ; (2) toute décision sur un `fullscreenchange` est **re-vérifiée après 300 ms** (`SETTLE_MS`) au lieu d'être prise sur le premier signal ; (3) le host n'est plus `display:none` mais `opacity:0 + pointer-events:none` — un élément non rendu peut recevoir le plein écran et s'afficher en noir sans la barre. Ajouté `?fsdebug` dans l'URL → trace chaque étape en console (begin/claim/refus/cancel) : un bug de plein écran est irreproductible sans savoir **quelle** étape le navigateur a refusée. **Leçon : ne jamais traiter un `fullscreenchange` isolé comme un fait — c'est un flux d'états transitoires.**

**Taille du bouton (retour user : "un poil trop petit").** Nos boutons custom codaient en dur `h-10 w-10` + icône `h-7 w-7` (28 px), alors que Vidstack dimensionne les siens via `.vds-button` = `--media-button-size` (40 px, **42 px en plein écran**) et l'icône via `.vds-icon` = **80 %** (32 px). D'où des glyphes visiblement plus petits que play/mute/fullscreen à côté. Fix : retirer les tailles fixes et ajouter la classe `vds-icon` aux `<svg>` → les 4 boutons custom (Download/Subs/Cast/Next) suivent exactement la métrique native, y compris le passage 40→42 px en plein écran. **Leçon : dans la chrome Vidstack, s'appuyer sur ses variables/classes plutôt que sur des tailles Tailwind figées** (ses règles sont en `:where()`, donc n'importe quel utilitaire Tailwind les écrase silencieusement).

**Garde-fous** : Échap pendant la transition (fullscreenchange → `fullscreenElement` null) → on annule et la page charge en fenêtré ; **watchdog 25 s** si personne ne réclame l'écran (source morte) → on sort du plein écran au lieu de bloquer sur un host noir ; si le 2ᵉ `requestFullscreen` est refusé (navigateur exigeant un nouveau geste) → on sort proprement = comportement d'avant, jamais de piège. iOS n'a pas de vrai plein écran (pseudo-FS CSS dans un state React que le remount perdait) → le flag est **mirroré hors de l'arbre** (`setPseudoFullscreenActive`) et restauré par le player suivant, nettoyé quand on quitte vraiment la page.

Tous les chemins de changement d'épisode du player passent maintenant par `navigateToEpisode()` : bouton de la barre, CTA "Next Episode" de SkipOverlay, **auto next episode**, raccourcis clavier next/prev. **Non couvert** (choix) : le changement d'épisode piloté par un pair en Watch-2gether (`router.push` dans la page watch) et le changement de **serveur**, qui démonte aussi le player.

**Bug trouvé en passant (bloquait tout `next build`)** : `lib/db/opedHostSkips.ts` avait `op_*/ed_*` dans un commentaire `/** */` — le `*/` **ferme le commentaire** → `Parsing error: ';' expected` à l'ESLint de build. Corrigé. Leçon : jamais de `*/` littéral dans un bloc de commentaire (et `next build` local échouait donc AVANT cette session — le lint de build est un gate réel).

**Note outillage** : `npx tsc --noEmit` sur tout le projet **OOM** (>8 Go, `allowJs` + `tools/` + `worker/` + toutes les pages dans un seul programme). Pour valider une modif : tsconfig scopé aux fichiers touchés (+ leurs imports) dans le scratchpad → 0 erreur ici ; `next lint --file …` marche normalement.

## 2026-07-06 (suite 21) — toasts player : pile collapse sonner (max 3) + barre fine teintée + croix

Retours user : la barre était trop épaisse / mal placée / trop blanche « flashy », et en fullscreen les toasts s'empilaient à l'infini au lieu de se collapser comme sonner (max ~3 visibles derrière, + une croix).

- **Pile collapse (fullscreen)** : on ne rend que les **3 plus récents** (`slice(-3).reverse()`). Le plus récent est devant (bas-droite), pleine opacité ; les 2 derrière sont `translateY(-14px*depth) scale(1 - 0.05*depth)`, opacité 0.6, `transformOrigin: bottom right` — le look « collapsed » de sonner. Chaque toast a un **bouton ✕** (top-right) pour le fermer. Conteneur `height:0` comme ancre absolue.
- **Barre de temps** : réduite **3px → 2px**, et **teintée `color-mix(in srgb, currentColor 45%, transparent)`** au lieu de blanc — `currentColor` = le texte rouge du toast → la barre matche la carte au lieu d'un trait blanc criard. Appliqué à la réplique in-player ET aux toasts sonner (`[data-sonner-toast]::after`, `currentColor` = couleur de texte richColors par type).

## 2026-07-06 (suite 20) — toasts player : barre de compte à rebours + vraie pile en fullscreen

Retours user : (1) ajouter sous chaque notif une petite barre blanche indiquant le temps restant ; (2) en fullscreen les notifs doivent **s'empiler** comme en fenêtré (avant : 2 slots fixes subNotice/chatWarning → une nouvelle notif identique écrasait la précédente).

- **Pile réelle in-player** : remplacé les états `subNotice`/`chatWarning` par une **file** `playerToasts: {id,msg,dur}[]` (id auto-incrémenté). `pushPlayerToast(msg,dur)` ajoute + programme le retrait ; `dismissPlayerToast(id)` filtre. `showPlayerNotice(msg,dur)` route : fenêtré → `toast.error` (sonner), fullscreen/pseudo-FS iOS → `pushPlayerToast`. `showSubNotice` = wrapper 3500 ms ; chat = 2600 ms. Timers nettoyés à l'unmount.
- **Barre de compte à rebours** : keyframe `toastCountdown` (scaleX 1→0). Réplique in-player : `<span>` absolu en bas, `animation: toastCountdown {dur}ms linear forwards` (conteneur `overflow:hidden` + `position:relative`). Toasts sonner fenêtrés : `[data-sonner-toast]::after` (sonner 1.0.3 n'a pas de barre native) animé sur 4 s (durée par défaut), coins bas via `border-bottom-*-radius: inherit` (pas d'`overflow:hidden` pour ne pas rogner le closeButton). Masqué sur `[data-removed=true]`.

## 2026-07-06 (suite 19) — notices subs/chat : vrai toast sonner en fenêtré, réplique in-player en fullscreen

Retour user (suite de la suite 17) : il veut le **vrai toast sonner** du site (carte rouge richColors, bas-droite) en mode fenêtré, et **la même chose répliquée dans le player** en plein écran (où un toast sur `<body>` est masqué).

- `inFullscreenNow()` : helper qui teste `fullscreenElement || webkitFullscreenElement || iosPseudoFsRef.current` (le pseudo-fullscreen iOS CSS masque aussi les toasts `<body>`). `iosPseudoFsRef` = mirror de l'état `iosPseudoFs` (synced via effect).
- `showSubNotice` et le handler `partyChat` (pas de party) : **fenêtré → `toast.error(msg)`** (sonner, exactement le style du site) ; **fullscreen → `setSubNotice`/`setChatWarning`** qui alimentent la réplique in-player.
- Réplique in-player restylée aux **couleurs exactes de sonner 1.0.3 richColors "error" (dark)** : bg `hsl(358,76%,10%)`, bordure `hsl(357,89%,16%)`, texte `hsl(358,100%,81%)`, + icône cercle-exclamation rouge, gras 600 — identique au toast fenêtré. Toujours portalée dans `playerElState`, bas-droite (`right:16, bottom:88`), empile subs+chat.
- `toast.error` (rouge) et non `warning` (ambre) pour coller au SS fourni par le user.

## 2026-07-06 (suite 18) — Ctrl+R rotait la vidéo au lieu de recharger

Bug : `comboFromEvent` ne garde que le `event.code` physique (ex. `keyr`) et **ignore les modificateurs**. Donc `Ctrl+R` matchait le binding `rotate` (r) et `preventDefault()` tuait le reload navigateur. Idem pour tout chord OS (Cmd+L, Ctrl+T…).

Fix dans le dispatcher clavier (`UniversalPlayer`, `onKey`) : on **bail avant le lookup si `ctrlKey || metaKey` est actif**, sauf si la touche pressée EST elle-même un modificateur (`code` commence par `control`/`meta`) — pour ne pas casser un binding standalone sur Ctrl/Meta. L'éditeur ne peut de toute façon pas binder de combo Ctrl/Meta, donc un tel chord est toujours celui du navigateur.

## 2026-07-06 (suite 17) — notices player (subs incrustés / chat) au format toast du site (bas-droite, fullscreen-safe)

Retour user : les bannières in-player « sous-titres incrustés » (bas-centre) et « rejoins une party » (haut-centre) marchaient mais ne ressemblaient pas aux toasts sonner du reste du site (petite carte en bas-droite). On veut le même look **tout en restant visible en plein écran**.

- Un vrai `toast()` sonner rend dans `document.body` → invisible quand `.vds-player` est l'élément fullscreen. Donc on ne peut pas juste réutiliser sonner.
- Solution : une **pile de toasts in-player** unique, portalée dans `playerElState` (createPortal), stylée comme la carte sombre de sonner (rounded 12, `rgba(10,10,10,0.94)`, bordure blanche 12 %, blur, ombre), positionnée **bas-droite** (`right:16, bottom:88` pour passer au-dessus de la barre de contrôle). `pointer-events:none` sur le conteneur, `auto` sur chaque carte (clic = dismiss).
- `subNotice` et `chatWarning` (états existants) sont routés dans cette même pile et **empilés** (gap 8). Supprimé les deux anciens blocs (bas-centre + haut-centre). Timers d'auto-dismiss inchangés (3,5 s / 2,6 s).

## 2026-07-06 (suite 16) — countdown négatif + trads manquantes (schedule) + keys tooltip + onglet Découvrir

Retours user :
- **Compte à rebours "à ne pas manquer" affichait des valeurs négatives** (`-1 j / -3 h / -34 min / -53 s`) : quand l'heure de diffusion cible est déjà passée, `countDown` devient négatif et `Math.floor` propage le signe sur chaque unité. Corrigé dans `useCountdownSeconds` : `Math.max(0, rawCountDown)` en tête de `getReturnValues` → on affiche 0/0/0/0 jusqu'à ce que `update()` charge le prochain épisode.
- **"Don't miss out!" / "Coming Up Next!" en dur** dans `components/home/schedule.js` (jamais traduits). Extraits en `home.dontMissOut` / `home.comingUpNext` (en + fr : « À ne pas manquer ! » / « Prochainement »).
- **Tooltip de l'éditeur de raccourcis : noms de touches en dur en français** (`capGlyph` retournait « Espace », « Entrée », « Flèche gauche »…). Passe par `shortcuts.keys.*` (en+fr), `capGlyph(code, t)`. Les labels imprimés SUR les caps AZERTY (ù, *, ;) restent tels quels.
- **Onglet FR "Découverte" → "Découvrir"** (`nav.discover`).

## 2026-07-06 (suite 15) — layout raccourcis corrigé + icône chat + ghosts Entrée/Espace + chat non-fullscreen

Retours user (2e passe sur les raccourcis) :
- **Layout corrigé (v4→v5)** : `$`=frameFwd, `^`=frameBack, `p`=prevEp, `o`=PiP, `s`=stats, `d`=cast, `f`=fullscreen, `c`=subs, `v`=screenshot, `b`=lien, `n`=nextEp, `;`=rateDown, `:`=rateUp. `keym`/`keyg`/`keyi` deviennent libres. Bump storage sinon les maps v4 sauvegardées écrasent les nouveaux défauts.
- **Icône chat** = SVG Material "chat" fourni par le user (bulle + lignes de texte), remap `translate(0,24) scale(0.025)`.
- **Ghost de drag** : retiré le cap de largeur à 240px (l'Espace prend enfin sa vraie largeur ; Chrome snapshot les images larges tant que le ghost est opaque + on-screen). Enter = moitié haute de la case (rectangle large 1.5u × 1 rangée), pas le bounding box 2 rangées.
- **Chat non-fullscreen ne force plus le plein écran** : le handler `partyChat` dispatch juste `aniscroll:openPartyChat`. En fullscreen → `FullscreenChat` (gate `active`) ouvre + focus ; fenêtré → `WatchPartyPanel` (gate `!document.fullscreenElement`) focus son composer. Exactement un des deux réagit.
- **Message d'erreur "pas dans une party" visible en fullscreen** : `toast.error` rend dans `document.body` → invisible quand le player est l'élément fullscreen. Remplacé par une bannière éphémère (`chatWarning`) rendue DANS le player (z-60, auto-dismiss 2.6 s).

## 2026-07-06 (suite 14) — ghost Entrée trop petit + megaplay sous les menus + doublon seek ±5s

Retours user :
- **Ghost de drag de la touche Entrée trop petit** : `onDragStart` mesurait `e.currentTarget` (le cap intérieur) qui porte `transform: scale(0.9)` au survol — or une touche est TOUJOURS survolée au moment où on la saisit → rect 10 % trop petit. Corrigé : on mesure le **parent** (la case de grille, jamais scalée) et on retire l'inset `GAP_PX`. Pour l'ISO Enter (forme en L, `h:2`) le ghost prend la **moitié haute** (tuile 1 rangée large) plutôt que le bounding box 2 rangées — marqué via `data-enter="1"`.
- **Gros bouton play (megaplay) par-dessus les menus** : `CenterPlayButton` (z-index 15) couvrait chapitres/settings/sous-titres Vidstack. Il n'apparaît qu'avant le 1er play (`everStarted`), donc visible si position reprise mais jamais lancée. Corrigé : on lui passe `menuOpen={vdsMenuOpen}` (état déjà suivi via `data-open`) → `return null` quand un menu est ouvert, réapparaît à la fermeture.
- **Doublon raccourci seek ±5s** : `seekBackwardLong`/`seekForwardLong` (j/l) faisaient exactement le même ±5s que `seekBackward`/`seekForward` (flèches). Supprimé les deux actions "Long" (type union, catalog, defaults, switch, icônes, i18n en/fr).
- **cycleServer (z) suit l'ordre d'affichage** : le handler dans [...info].js itérait sur l'ordre brut de `lib/servers` filtré par confirmed only. Réécrit pour reproduire EXACTEMENT l'ordre du sélecteur : `[...multi, ...vo, ...vf]` (chaque groupe fastest-first via `getServersByLang`) filtré par la même règle `shouldShow` (actif toujours visible, failed masqué, iframe toujours visible, sinon confirmed). Dépend maintenant aussi de `failedServers`.
- **Nouveau layout de raccourcis par défaut** (SS user = source de vérité) : gros reshuffle de `DEFAULT_KEYBINDINGS`. Rangée haute : cycleServer=e, rotate=r, PiP=i, prevEp=o, frameBack=p, frameFwd=^. Home : partyChat=t, stats=d, cast=f, fullscreen=g, ambient=l, mute=m(semicolon), OP=ù(quote), ED=*(backslash) — **skipIntro/Outro quittent PgUp/PgDn**. Rangée basse : subs=x, screenshot=c, copyLink=v, nextEp=b, rateDown=,(keym), rateUp=;(comma), rateReset=!(slash). Volume reste sur flèches (confirmé user). **Bump storage v3→v4** sinon les maps sauvegardées (anciennes positions) écrasaient les nouveaux défauts au merge.
- **Nouveau raccourci "parler dans le chat" sur `t`** (`partyChat`) : action ajoutée (type/catalog/défaut/icône bulle/i18n en+fr). Handler : si pas de `party` → toast `party.chatNeedsParty` ; sinon entre en plein écran (le chat est fullscreen-only) puis dispatch `aniscroll:openPartyChat`. `FullscreenChat` écoute l'event (gate `active`), ouvre le panneau + focus le composer. Pas de re-trigger : le composer est `contentEditable`, le guard clavier ignore déjà `isContentEditable`.

## 2026-07-06 (suite 13) — w2g create 500 (zadd NX cassé dans le shim REST) + icônes ambient/reset + drag espace

Retours user (SS console : `/api/v2/watch2gether/create` → 500) :
- **Impossible de créer une room** : `createRoom` → `addMember` fait `redis.zadd(orderKey, "NX", ts, userId)` (syntaxe ioredis : flag NX en tête). Le shim REST (`lib/redisRest.ts`) faisait `const [score, member] = args` → `score = Number("NX") = NaN`, `member = ts`. Upstash REST **rejette un score NaN par un 500** → tout le create tombe. **Bug transverse** : cassait TOUS les `zadd` avec flag NX (ordre membres w2g, `touchPresence`, cache saison…). Corrigé : `zadd` du shim **épluche les flags de tête** (NX/XX/GT/LT/CH) en objet d'options Upstash avant de lire la paire score/member. `zrange` gère aussi `WITHSCORES` (passe `{withScores:true}`, sortie aplatie comme ioredis). Vérifié contre la signature `@upstash/redis@1.38` (`zadd(key, opts, {score,member})`).
- **Icône raccourci "Ambient lights"** = même glyphe que le toggle Settings > Ambient (Material `lightbulb_outline`), pour la cohérence.
- **Icône `rateReset`** = SVG fourni par le user : cadran Material "speed" complet avec **aiguille en haut-droite** (vitesse neutre), remap `translate(0,24) scale(0.025)`.
- **Drag de la barre espace enfin réparé** : le ghost de `setDragImage` était créé à la **taille réelle** de la touche (~500px pour l'espace) ET **hors écran** (`-9999px`) → Chrome **annule le drag** dans ce cas. Ghost repassé en **tuile fixe 44px** rendue **à l'écran** (`top:0;left:0;z-index:-1`) → toutes les touches (espace inclus) se glissent.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 12) — Raccourcis : action ambient, cap vitesse x2, ghost de drag opaque, icônes

Retours user :
- **Nouvelle action `toggleAmbient`** (activer/couper les ambient lights) : handler `setAmbientCtx(!ctxAmbient)`, catalogue (groupe view), default sur cap "p"/`keyp` (libre depuis le retrait de seekToEnd), i18n fr/en, icône ampoule+rayons. Catalogue = 37.
- **Vitesse plafonnée à x2** : `rateUp` `Math.min(2,…)` + clamp interne de `onRateChange` (4→2). (Note perf : à x2 le `<video>` décode/joue nativement 2× plus vite ; pas de « skip de frames » applicatif possible/pertinent — c'est le décodeur qui suit ou non. Rien à optimiser côté JS.)
- **Debug raccourci retiré** (le vrai fix était le garde `!event.request`, cf. suite 11).
- **rateReset** : aiguille **verticale centrée** (neutre) + arc demi-cercle symétrique + badge reset (au lieu du cadran Material asymétrique).
- **Ghost de drag = tuile opaque** construite (fond `#20242c` + icône) au lieu du clone de la touche : le clone était quasi-transparent (fill sur enfants absolus) → le navigateur en faisait un halo ovale flou. Rectangle net désormais, à la vraie taille de la touche.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 11) — Raccourcis : FIX vitesse (garde !event.request), pavé num, icônes, hint

Retours user :
- **Vitesse ne faisait rien — CAUSE trouvée** : `onRateChange(next)` **retourne tôt si `!event?.request`** (ligne ~1562, pour ignorer les auto-resets de Vidstack). Les raccourcis l'appelaient **sans event** → no-op. FIX : les handlers `rateDown/rateUp/rateReset` posent `video.playbackRate` **directement** (effet immédiat) PUIS `onRateChange(r, { request: true })` (persistance + sync Vidstack).
- **Pavé numérique** : les touches émettent `event.code = "NumpadN"`, pas `DigitN` → aucun match. `comboFromEvent` **replie `numpadN` → `digitN`** (Num Lock requis pour émettre NumpadN).
- **Debug raccourcis** : log `[shortcut] {code, combo, action, hasVideo, rate}` derrière `localStorage.scDebug === "1"`.
- **Escape ferme** : listener déjà en place (suite 9), inchangé — capture sur window + stopPropagation.
- **rateReset** : remplace la roue-« soleil » du SVG par le **speedometer** (cadran de rateUp/Down) + badge flèche-reset en haut-droite.
- **frameBackward** : flèche décalée +1px à droite.
- **Hint du haut** : 2e phrase retirée (dragHint fr/en = juste « Glissez-déposez une icône sur la touche voulue. »).
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 10) — Raccourcis : tooltip en mots, cap "m" clair, retrait seekToEnd, icône reset-speed

Retours user :
- **Tooltip au survol = NOM de la touche en toutes lettres** (avant : symboles `↵ ⌫ ⇧`). `capGlyph` renvoie maintenant "Entrée", "Espace", "Échap", "Retour arrière", "Flèche gauche/droite/haut/bas", "Verr. Maj", "Maj gauche/droite", "AltGr", "Menu", etc.
- **Cap "m" trop foncé** : son code physique est `semicolon` (pas `key*`), donc `isMain` le classait "non-principal". Ajouté `semicolon` à `MAIN_PUNCT` → clair comme les autres lettres.
- **Retrait de l'action `seekToEnd`** ("Aller à la fin") : supprimée du type, catalogue, defaults (libère le cap "p"/`keyp`), handler, icône, i18n fr/en. Catalogue = 36 actions.
- **Icône `rateReset`** = SVG Material "speed + gear" fourni (compteur avec engrenage de réglage), remap `translate(0,24) scale(0.025)`.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 9) — Raccourcis : FIX codes AZERTY rangée du bas, Escape ferme, icônes échangées

Retours user :
- **Vitesse (et `,`) ne marchaient toujours pas** — CAUSE : les `event.code` de la **rangée du bas** étaient faux. `event.code` nomme la position **physique QWERTY** ; sur AZERTY les caps `, ; : !` sont aux positions physiques **KeyM / Comma / Period / Slash**, pas `comma/period/slash/intlbackslash`. Corrigé : cap ","→`keym`, ";"→`comma`, ":"→`period`, "!"→`slash`. Defaults ajustés (rotate→`keym`, rateDown→`comma`, rateUp→`period`, rateReset→`slash`). Storage bump **v3**. (Les autres rangées étaient déjà correctes.)
- **Escape ferme l'éditeur** : `useEffect` keydown (capture) → `onClose()` sur `Escape`.
- **seek ±5 : icône = juste texte « −5 » / « +5 »** (plus de flèche circulaire).
- **Échange épisode ↔ frame** : les icônes cadre-photo + flèche vont sur `frameBackward/frameForward` (image préc./suiv.) ; `prevEpisode/nextEpisode` reprennent les chevrons |◄ / ►|.
- **Flèche du cadre frameBackward** décalée à droite (plus de superposition avec le bord).
- **Mute** : ✕ encore décalée à droite.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 8) — Raccourcis : FIX matching (event.code), rotate remplace mirror, seek ±5, nouvelles icônes

Retours user, dont un **bug fonctionnel majeur** :
- **« la plupart des boutons ne marchent pas » (chiffres rangée du haut, rateDown, …)** — CAUSE RACINE : le matching se faisait sur `event.key`. Sur **AZERTY**, la rangée des chiffres et une bonne part de la ponctuation (`; : ! ^ $ * ù`) n'émettent leur caractère qu'**avec Shift** ; une frappe simple donne `&é"'(-è_ç…`, donc le combo stocké (`"1"`, `";"`) ne matchait jamais. FIX : tout le système passe à **`event.code`** (position physique, indépendante du layout et de Shift). `comboFromEvent` = `e.code.toLowerCase()`. Les caps de l'éditeur portent maintenant leur `event.code` (`digit1`, `keyq`=cap "a", `semicolon`=cap "m", …) + un `label` d'affichage AZERTY. Defaults réécrits en codes. **Bump storage key → `aniscroll:keybindings:v2`** pour jeter les anciennes valeurs key-based.
- **`mirror` → `rotate` (rotation 90°)** : action, catalogue, handler (cycle 0/90/180/270 via `transform: rotate()`), i18n (fr/en), icône (SVG Material "rotate 90°" fourni). Plus d'action `mirror`.
- **seek ±10 → ±5** : `seekBackwardLong`/`seekForwardLong` passent à 5s ; icônes = flèche circulaire replay/forward avec un **« 5 »** au centre.
- **prevEpisode/nextEpisode** : nouvelle icône = cadre photo Material + montagnes, **flèche gauche (prev) / droite (next)**.
- **mute** : ✕ décalée plus à droite, détachée du haut-parleur.
- **rateUp** = miroir horizontal du cadran, badge `+` en haut-droite (inchangé depuis suite 7).
- Drag = clone de la vraie touche (suite 7) : devrait régler l'aperçu bizarre de l'espace ; à confirmer en interaction réelle.
- `tsc`/`lint`/JSON ok ; 37/37 defaults sur le board, aucun doublon.

---

## 2026-07-06 (suite 7) — Éditeur raccourcis : clavier ×1.5, icônes +, drag = vraie forme de touche, rateUp miroir

Retours user (SS) :
- **Clavier ×1.5 (pas 1.8)** : `max-w` `min(1400px,94vw)` → `min(1200px,92vw)`.
- **Icônes bien plus grandes** : `width/height` 17→26px.
- **Aperçu de drag = vraie forme/taille de la touche** : `onDragStart` clone maintenant `e.currentTarget` (l'élément touche réel) à sa `getBoundingClientRect()` et le passe à `setDragImage` — donc glisser la barre espace donne un ghost large, l'Enter ISO sa forme en L, etc. (avant : carré fixe 44px figé à l'ancienne taille). Retrait de l'`id="sc-icon-*"` et du ghost synthétique devenus inutiles.
- **rateUp = miroir horizontal (axe Y) de rateDown** : le cadran est mirroré (`translate(23,22.5) scale(-0.02,0.02)`) → aiguille sort à gauche ; le badge **+ reste en haut-droite** (non mirroré). rateDown inchangé (ouverture à droite + −).
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 6) — Éditeur raccourcis : gap uniforme px, clavier ×1.8, ghost de drag, Enter highlight opaque, icône vitesse pleine

Retours user (SS) :
- **Rendu bizarre au drag de l'espace** (aperçu étiré à la taille de la touche large) : `onDragStart` crée un **ghost custom** de taille fixe (44px) qui copie l'icône (via `id="sc-icon-<action>"` posé sur le `<svg>` de la touche) et le passe à `setDragImage`, puis le retire au tick suivant. Aperçu de drag identique quelle que soit la largeur de touche.
- **Rose du Enter bizarre au survol-drop** : le highlight `isDrop` passait par un rgba **0.35** → les 2 rects superposés de l'Enter ISO doublaient l'alpha (patch plus foncé au croisement). Passé en **couleur opaque** `#6f2338` → forme en L uniforme.
- **Espacement ×3 + gap uniforme** : le padding `%` n'était pas uniforme (grille 16×5 non carrée → colonnes très espacées, rangées serrées). Remplacé par un **inset px fixe** (`GAP_PX=6`) → gap identique sur les 4 côtés.
- **Clavier ×1.8** : `max-w` fixe → `min(1400px, 94vw)`.
- **Icône vitesse refaite** (aiguille non centrée / ouverture à gauche) : retour au **path Material "speed" complet** (cadran + aiguille centrée intégrée), scale 0.02, l'aiguille sort par l'**ouverture à droite** ; même cadran pour down/up, seul le badge −/+ change (coin haut-droite). Vérifié en zoom.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 5) — Éditeur raccourcis : espacement +, clavier +, badge vitesse en haut-droite

Retours user (SS) :
- **Espacement encore trop petit** : `GAP` inset 0.9→1.4.
- **Clavier un peu plus grand** : `max-w` 720→820px.
- **Badge −/+ des icônes vitesse illisible (superposé au cadran)** : cadran réduit (`scale(0.021)`) et décalé en bas-gauche (`translate(-1.5,25.5)`) pour libérer le coin haut-droite ; le badge y est placé, agrandi et arrondi (− = rect rx1, + = croix épaisse). Aiguille resserrée en conséquence. Vérifié en zoom : cadran + aiguille + badge distincts dès 18px.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 4) — Éditeur raccourcis : plus d'espacement, `- = ^ $ ù *` en clair, icônes vitesse "speedometer"

Retours user (2 SS) :
- **Touches encore trop serrées/collées** : `GAP` inset 0.45→0.9 (espacement franc entre touches, comme le 2e SS de réf).
- **`- = ^ $ ù *` ajoutés au groupe clair** : `isMain` = `[a-z0-9]` **plus** `MAIN_PUNCT` (Set `, ; : ! - = ^ $ ù *`) — passage regex→Set pour ne pas avoir à échapper `- $ ^ *`. Reste foncé : tab, entrée, espace, nav, modificateurs, capslock.
- **Icônes rateDown/rateUp refaites** d'après le SVG Material "speed" fourni : cadran (dial) commun + aiguille orientée (bas-gauche = ralentir, bas-droite = accélérer) + badge −/+. Le path Material est en viewBox `0 -960 960 960` → remis dans `0 0 24 24` via `<g transform="translate(0,24) scale(0.025)">` (piège : PAS de flip `-0.025`, sinon le cadran disparaît hors-cadre). Aiguille + badge dessinés directement en 24×24.
- `tsc`/`lint` ok ; vérif réplique (clavier + zoom des 2 icônes vitesse).

---

## 2026-07-06 (suite 3) — Éditeur raccourcis : clavier plus compact, teinte foncée constante, `,;:!` en clair

Retours user (screenshot) :
- **Clavier trop gros / touches collées** : `max-w` 860→720px et `GAP` inset 0.2→0.45 (touches à nouveau distinctes, board plus compact — sur le SS il débordait à ~1120px).
- **Teinte foncée indépendante de l'action** : le fond ne dépend plus de `action` — `isMain` (alphanumérique) → `#20242c`, tout le reste → `#181b21`, **avec ou sans action**. Une touche nav vide reste plus sombre qu'une touche lettre vide. La distinction assigné/vide se fait par la présence de l'icône, plus par la couleur.
- **`, ; : !` reclassés "main"** (couleur claire comme lettres/chiffres) : regex `isAlnum`→`isMain` = `[a-z0-9,;:!]`. (`^ $ ù *` restent dans le groupe foncé.)
- `tsc`/`lint` ok ; vérif réplique + screenshot.

---

## 2026-07-06 (suite 2) — Éditeur raccourcis : touches jointives, non-alphanum plus sombres, icônes OP/ED partagées

Retours user (screenshot) :
- **Espacement resserré** : `GAP` inset 0.55→0.2 (touches quasi jointives, comme la réf).
- **Touches non-lettres/chiffres plus sombres** : nouveau test `isAlnum` (`[a-z0-9ùç^$]`) — les touches alphanumériques gardent `#20242c` (assigné) / `#131519` (vide un peu foncé), tout le reste (nav, modificateurs, ponctuation, espace, entrée…) prend `#181b21` quand assigné, même vide sinon — lisible comme un vrai clavier où la zone de frappe se distingue du reste.
- **skipIntro/skipOutro réutilisent l'icône du menu Settings > Automation** (badge cadre arrondi + monogramme "OP"/"ED", `SettingsToggleRow` dans `UniversalPlayer.tsx`) au lieu d'un chevron générique — même glyphe aux deux endroits où l'action apparaît.
- `tsc`/`lint` propres ; vérif visuelle via réplique + screenshot headless.

---

## 2026-07-06 (suite) — Éditeur raccourcis : tout assignable, Enter ISO, fond flou, header minimal

Retours user (5 points) :
- **Toutes les touches assignables** (plus de touches « mortes » plus foncées) : les modificateurs ont maintenant un code = `event.code` minuscule (`shiftleft`, `shiftright`, `controlleft`, `metaleft`, `altleft`, `altright`, `capslock`, `contextmenu`) — ça distingue les 2 Shift (même `event.key`). `comboFromEvent` retourne désormais le code seul pour un modificateur pressé (sans se préfixer lui-même) ; le handler inline d'UniversalPlayer (qui ignorait les modificateurs et dupliquait la normalisation) est remplacé par `comboFromEvent` — source unique.
- **Enter en vraie forme ISO** : deux rects arrondis superposés (moitié haute pleine largeur 1.5u, moitié basse 1.25u alignée droite) — tous les coins convexes restent arrondis (un `clip-path` aurait donné des coins vifs). Capslock rétabli à 1.75u, ghost 1.25u. Icône centrée sur la moitié haute.
- **Toutes les actions assignées par défaut, aucune désassignation possible** : `skipIntro`=pageup, `skipOutro`=pagedown (37/37 liées, plus de `null`). Tray supprimée. `getKeybindings()` **purge les valeurs null/vides** du localStorage (anciennes versions permettaient l'unbind) pour que le défaut reprenne la main.
- **Header minimal juste au-dessus du clavier** : texte raccourcis à gauche, Réinitialiser + croix à droite. Hint bas + `keyboardHint` (locales) supprimés. Tooltip pill = absolute au-dessus du board (plus de rangée réservée).
- **Fond = flou** (`backdrop-filter: blur(20px)` + noir 45 %), plus de sheet noire ; **clavier réduit** (max-w 1040→860, icônes 19→17px, bezel p-3/r-18, touches r-8).
- `tsc`/`lint`/JSON ok ; réplique + screenshot headless conformes.

---

## 2026-07-06 — Éditeur raccourcis : clavier AZERTY 75 % (nav en ligne), fix icône espace

Retours SS (2e screenshot) : ordre de touches exact demandé, style laptop 75 %. Le commit `507b782` (fait entre deux sessions) avait déjà l'AZERTY mais avec un **pavé nav détaché** à droite (trou au milieu) — pas conforme à l'ordre donné. Corrections :
- **Layout 75 %** : les touches nav sont **en ligne** en bout de rangée — `delete` (fin R1), `home` (après Enter, R2), `pageup` (fin R3), `↑`+`pagedown` (fin R4), `←↓→` (fin R5). Plus de cluster `NAV` séparé ; chaque rangée totalise exactement **16 unités**.
- **Enter ISO sur 2 rangées** (w1.5, h2) ; capslock réduit à 1.5u pour que la moitié basse du Enter ne chevauche pas `*`. Nouvelle notion `ghost` dans `Key` = cellule sous le Enter, **non rendue** (sinon elle se dessinerait par-dessus).
- **Fix bug icône espace au drag** : icône SVG en taille fixe (19px) centrée en absolu — ne s'étire plus avec la touche large (déjà dans `507b782`, confirmé avec le nouveau layout).
- Coordonnées toujours **calculées** (walk gauche→droite par rangée) — zéro x manuel, zéro collision.
- Vérif : réplique HTML générée depuis les sources + screenshot Edge headless (rangées alignées, Enter tall OK, espace OK). `tsc`/`lint` propres ; les 35 defaults pointent tous vers des touches présentes.
- Piège local (nouvelle machine, chemin OneDrive) : Edge headless ne résout pas les chemins courts `LUC~1.DEL` en URL `file:///` — utiliser le chemin long complet.

---

## 2026-07-05 (suite 4) — Éditeur raccourcis : polish visuel SS + retrait 2 actions

Retours SS : le clavier ne collait toujours pas. Corrections :
- **Fond noir pur, zéro bordure** partout (bezel `#0b0c0f` arrondi 22px sur `#000`, touches `#20242c`/`#15171c` **sans bordure**). Couleurs alignées sur le SS.
- **Toutes les touches** animent au hover (rétract `scale(0.9)`), y compris les vides (avant : seules les assignées).
- **Plus de désassignation** : suppression du double-clic-pour-libérer et de la tray « drop to unbind ». Déposer une action sur une touche occupée **échange** les deux (aucune action perdue). Les actions hors board vivent dans une tray fine ; les y déposer évince le résident vers la tray.
- **Retrait de `cycleAspect` (ratio d'image) et `toggleTheater` (mode cinéma)** (demande user). L'event `aniscroll:toggleTheater` n'est plus émis.
- **Icônes refaites** (jugées moches/cassées) : `rateDown/Up` (triangle + badge −/+), `seekBackwardLong/Long` (double-chevron replay/forward-10, distinct des ±5s), `mirror` (2 triangles autour d'un axe), `skipIntro/Outro` nettoyés.
- Vérif visuelle : réplique HTML statique générée depuis les sources (ROWS/defaults/icons) + screenshot headless Edge (le dev server Next ne build pas en local — `@upstash/redis`/`ably` absents, cf. entrées précédentes ; ne PAS `npm install` ces paquets, ça prune des deps hors-lockfile). Rendu conforme au SS.
- Catalogue = **39 actions**. `tsc`/`lint`/JSON propres, defaults sans collision.

---

## 2026-07-05 (suite 3) — Éditeur raccourcis refait « keyboard-only » (design SS) + 4 actions

Retour user : le two-pane (liste à gauche + clavier) ne correspondait pas au SS. Il veut **QUE le clavier**, centré, sans encadré ni liste latérale ; **hover d'une touche = tooltip « Touche : Action »** + la touche **rétrécit** (anim `scale(0.9)`) ; **defaults = exactement ceux du SS** (mêmes icônes sur mêmes touches).

### Refonte [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Plein écran, **clavier seul centré** (plus de carte/bordure autour, plus de colonne d'actions à gauche). Barre du haut = titre + Réinitialiser + fermer.
- **Tooltip flottant** au survol (pill noire au-dessus du clavier), **key retract** au hover.
- Drag & drop **touche → touche** pour déplacer une icône ; **double-clic** = libérer. Les actions **non placées** vivent dans une **tray fine sous le clavier** (se cache quand tout est placé ; déposer une icône dedans = retirer). C'est le seul « réservoir » pour rebinder une action absente du board, tout en gardant la vue principale = clavier pur.
- Defaults **calqués sur le SS** (icône par touche : ↺ en fin de row1, theater/subs/PiP/jump/link/loop en row2, brightness/flip/cast/fullscreen/frame-step en row3, screenshot/aspect/prev/next/mute/vol en row4, play sur Espace + rewind/vol/ffwd autour). `skipIntro/skipOutro` **non bindés par défaut** (le SS n'en a pas), draggables depuis la tray.

### 4 actions de plus (demande user)
- **Aller à % (1–9)** : 9 actions `seekPct10…90` → saute à N×10 % de la durée (façon YouTube). Number-row 1–9 par défaut. Icône = barre de progression + digit.
- **Miroir horizontal** (`mirror`) : toggle `transform: scaleX(-1)` sur le `<video>` (indépendant de `cycleAspect` qui, lui, joue sur `objectFit`).
- (rappel itération précédente : `cycleServer`, `copyTimestamp`.) Catalogue = **41 actions**.
- Vérifs : `tsc` propre (hors préexistants), `next lint` 0 warning, JSON valides, pas de collision de touche dans les defaults (script de check).

---

## 2026-07-05 (suite 2) — Raccourcis : éditeur drag&drop, fix décalage menu, 2 actions de plus

Itération sur la feature raccourcis (retours SS du user).

### Éditeur repensé en drag & drop ([ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx))
- Nouveau modèle (demande user, inspiré d'une réf de clavier) : **glisser une action** de la liste **sur une touche** pour l'assigner (avant : clic-action puis appuie-touche). Déposer sur la liste = désassigner ; **double-clic** sur une touche = libérer ; on peut aussi soulever l'icône d'une touche pour la déplacer.
- **Clavier épuré** : plus AUCUNE lettre imprimée sur les touches. Une touche assignée affiche l'icône de son action, sinon vide. Le **nom de la touche s'affiche seulement au survol** (tooltip). Style aligné sur la réf (bezel quasi-noir, touches plates).
- Defaults redistribués sur le clavier à la manière de la réf (icônes éparpillées) dans [keybindings.ts](lib/prefs/keybindings.ts).

### Fix décalage « Lumières d'ambiance » (et toutes les lignes injectées)
- Les rows `.as-menu-row` avaient `padding: 0 12px` alors que Vidstack natif utilise `--media-menu-item-padding: 10px` (vérifié dans `node_modules/@vidstack/.../menus.css` L315) → icône+label poussés ~2px trop à droite vs Speed/Qualité. Corrigé : `padding: var(--media-menu-item-padding, 10px)` dans [globals.css](styles/globals.css).

### Retrait du toggle « Statistiques vidéo » du menu (demande user)
- Plus de ligne stats dans le menu du lecteur ; l'overlay stats s'ouvre uniquement via son **raccourci clavier** (`toggleStats`). La ligne « Configurer les raccourcis » reste.

### 2 actions ajoutées (+ propositions)
- **`cycleServer`** (changer de lecteur) : le player n'a pas la liste des serveurs → il émet un CustomEvent `aniscroll:cycleServer` ; la watch page ([watch/[...info].js](pages/en/anime/watch/[...info].js)) écoute et avance vers le **prochain serveur confirmé** (fallback = liste complète), wrap-around, toast `player.switchedTo`. Même pattern que `toggleTheater`.
- **`copyTimestamp`** (copier le lien horodaté) : copie l'URL courante avec `?t=<sec>` + toast « à 12:34 ». Le player **honore `?t=` au chargement** (prioritaire sur le resume sauvegardé, consommé une fois puis retiré de l'URL via `replaceState`).
- Catalogue = **30 actions** désormais. i18n fr/en (`shortcuts.actions.cycleServer/copyTimestamp`, `stats.timestampCopied/Failed`, `player.switchedTo`).
- Vérifs : `tsc` propre (hors `ably`/`@upstash/redis` préexistants), `next lint` 0 warning, JSON valides.

---

## 2026-07-05 (suite) — Raccourcis clavier configurables + clavier visuel + stats vidéo

Demande user (screenshot d'un clavier physique avec icônes sur les touches) : assigner des touches aux actions du lecteur, même design que le SS, réglable dans le lecteur ET les settings globaux.

### Système de raccourcis (data-driven)
- [lib/prefs/keybindings.ts](lib/prefs/keybindings.ts) : catalogue de **28 actions** (`ShortcutAction`), map `action -> combo` en localStorage (`aniscroll:keybindings`), même pattern que `playerPrefs.ts` (CustomEvent + hook `useKeybindings`). Combos normalisés (`"shift+s"`, `"arrowright"`), helpers `comboFromEvent`/`comboLabel`/`comboToAction`. Defaults sensés (k=play, ←/→=±5s, ↑/↓=volume, m=mute, f=fullscreen, n/p=ep suiv/préc, s/d=skip intro/outro, etc.).
- **Handler central** dans [UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx) : un seul `keydown` en **capture phase** (gagne sur les hotkeys natifs Vidstack → `preventDefault`+`stopPropagation` quand on possède la touche). Ignore les champs de saisie + le blocage watch-party. Dispatcher `runAction(action)` → op impérative sur le `<video>`/player/hls.
- **Piège hooks** : le dispatcher a besoin de helpers définis tard (`subtitleTracks`, `selectSubtitleTrack`, `togglePip`…) donc `runAction` vit après les early-returns iframe. Mais `useRef`/`useEffect` ne peuvent PAS être après un early return (rules-of-hooks). Fix : ref `runActionRef` + `useEffect` déclarés **en haut** (avant tout return), le dispatcher est **publié** dans la ref plus bas (simple assignation, pas un hook). Sur le chemin iframe l'assignation ne s'exécute jamais → ref null → handler no-op (correct : pas de `<video>` à piloter).

### Clavier visuel (overlay) — [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Reproduit le SS : bezel quasi-noir, touches sombres, **icône de l'action peinte sur la touche assignée**, tooltip flottant « S : Skip Intro ». Layout QWERTY en data (`ROWS`), touches mortes (Shift/Ctrl) non assignables.
- Modèle d'édition retenu (question au user) : **clic action → appuie une touche**. Liste d'actions groupée à gauche ; cliquer une action « écoute » puis capture la 1re touche (window keydown capture, ignore les modificateurs seuls, Esc annule). Une touche = une seule action (retire le combo des autres actions). Chip du combo + bouton clear + reset global.
- Chargé en **`next/dynamic` ssr:false** (overlay lourd, rare) depuis le lecteur ET les settings. Icônes SVG dans [shortcutIcons.tsx](components/watch/primary/shortcutIcons.tsx).

### Stats vidéo — [VideoStats.tsx](components/watch/primary/VideoStats.tsx)
- Panneau « stats for nerds » : lit le `<video>` + l'instance hls.js (résolution, FPS, bitrate, bande passante estimée, buffer, frames perdues, serveur). Poll ~2 Hz via rAF (pas de `useMediaState` → ne re-rend pas le player). Sibling overlay (survit au fullscreen).
- **Screenshot → presse-papiers** : `captureScreenshot()` dessine la frame sur un canvas → `ClipboardItem` (fallback download si pas de support clipboard-image ; toast d'erreur si canvas tainted = source noCors).

### Entrées + divers
- Bouton « Configurer les raccourcis » dans le menu Settings du lecteur **et** dans Settings globaux (section Lecteur) → même overlay. + ligne toggle « Stats vidéo » dans le menu lecteur.
- Ajout **`prevEpisodeHref`** (le lecteur n'avait que `nextEpisodeHref`) — dérivé de `episodeNavigation.prev` dans [watch/[...info].js](pages/en/anime/watch/[...info].js), passé aux 2 usages `UniversalPlayer` (HLS + iframe).
- Actions directes-only (seek/volume/screenshot/skip) = no-op gracieux sur embeds iframe (megaplay) : pas de `<video>` accessible.
- i18n fr+en (`shortcuts.*`, `stats.*`). Vérifs : `tsc` propre sur les fichiers touchés (seules erreurs = `ably`/`@upstash/redis` manquants, préexistantes), `next lint` 0 warning, JSON valides.

### Graphify (méta)
- Le user avait installé **Graphify** (graphe de connaissance du repo, `graphify query "..."`) pour réduire la conso de tokens. Je ne l'utilisais pas car le hook PreToolUse ne se déclenche que sur `Bash` grep/find, pas sur mes tools `Grep`/`Glob`. → **Mémoire durable ajoutée** ([[graphify]] dans MEMORY.md) : consulter `graphify query` en premier pour localiser du code. CLI v0.8.27, output `graphify-out/` (gitignored).

---

## 2026-07-03 (suite) — Megaplay routé via Worker + synchro AniList ON par défaut avec choix de sens

Deux chantiers indépendants dans la même session.

### Fix : « Megaplay manque souvent alors que la vidéo existe »
- **Cause racine** : `extractMegaplay` ([lib/extractors.js](lib/extractors.js)) fetchait `megaplay.buzz` **en direct**. Or megaplay est **derrière Cloudflare** (vérifié : `Server: cloudflare`, `CF-RAY`), qui 403/challenge les **IP datacenter AWS de Vercel**. → marche en local (IP résidentielle) mais échoue souvent en prod → le chip disparaît. **Exactement la même classe de bug qu'anime-sama**, déjà réglée en passant par le Worker CF.
- **Fix** : helper `fetchMegaplay()` qui route la page embed **et** `getSources` via `fetchViaWorker` (requête depuis le réseau Cloudflare → passe), avec **fallback fetch direct** si le Worker est absent/injoignable (dev local). Le Worker met déjà le bon Referer `megaplay.buzz` ([worker/src/index.js](worker/src/index.js) `detectReferer`) et repasse le JSON verbatim — pas besoin de `X-Requested-With` ni de Referer par-requête (vérifié en live à travers le Worker).
- **Commentaires périmés corrigés** : (1) la route `/stream/ani/<aniListId>` n'est **pas** morte (répond en <0,5 s, vrai fallback — testé Frieren ani/154587) ; (2) la page ne **410 plus** sans Referer (renvoie 200). Le « file not found » de megaplay est un **200 avec `<title>Error - MegaPlay</title>`** → le check HTML existant le rattrape même à travers le Worker (le Worker ne wrappe pas ce cas en erreur).
- **Rien d'autre en cause** : routage MAL→AniList, regex `data-id`, `episode`/`aniId` par-entrée envoyés par le client = tous corrects. Aucun changement serveur/client nécessaire. **Le Worker doit être déployé** (il l'était déjà) pour que le fix prenne effet en prod.
- Vérifié end-to-end en forçant le chemin Worker : routes MAL + AniList résolvent (1 stream + 9 pistes de sous-titres), épisode inexistant → `file not found`, fallback direct OK.

### Feature : synchro AniList activée par défaut + choix de sens (au lieu du message d'écrasement)
- **Demande** : (1) sync ON par défaut quand l'utilisateur se connecte, (2) remplacer le message « votre liste va être écrasée » par un **choix de sens** — soit AniList écrase le local, soit **le local est poussé vers AniList** (ajoute les anime du site), (3) **toast** de confirmation à la connexion (style « Entrée de liste enregistrée »).
- **Nouveau sens `local → AniList`** : `fullSyncToAniList()` ([lib/list/syncEngine.ts](lib/list/syncEngine.ts)) pousse chaque entrée locale via `SaveMediaListEntry` (ajoute OU met à jour). **Ne supprime jamais** rien côté AniList (les entrées présentes seulement sur AniList sont laissées telles quelles) — c'est bien « ajouter ma liste du site », pas un remplacement. Séquentiel (1 mutation à la fois) pour rester sous la limite AniList (90 req/min), best-effort par entrée, patch du cache client au fil de l'eau.
- **Popup au 1er login** (choix retenu via question) : composant réutilisable [SyncDirectionModal](components/shared/SyncDirectionModal.tsx) à 2 boutons (« Utiliser ma liste AniList » = hard-override / « Utiliser ma liste AniScroll » = push). Piloté par `SyncBootstrap` dans [_app.tsx](pages/_app.tsx), **placé DANS `<SessionProvider>`** (sinon pas de `useSession()` — `MyApp` est au-dessus du provider).
- **Garde anti-nag** : nouveau flag `directionChosen` dans [syncPrefs.ts](lib/prefs/syncPrefs.ts). `enabled` passe à `true` par défaut (inoffensif pour les invités : `getAniListSession` renvoie `null` sans token). **Piège évité** : le resync de fond de `_app` (pull AniList→local, non-destructif mais overriding) est **gaté sur `directionChosen`** — sinon un nouvel utilisateur avec une liste locale la perdrait avant d'avoir pu choisir « pousser vers AniList ». `cancel` compte comme répondu (sync reste ON, aucun reconcile) pour ne pas rouvrir à chaque navigation.
- **Toast** : `toast.success` avec `description` (supporté par sonner 1.0.3) — titre « Synchronisation AniList activée » + sous-ligne. Même style que le screenshot fourni.
- **Settings** : le toggle master ouvre désormais le même `SyncDirectionModal` (au lieu du confirm à sens unique). Clés i18n `confirmTitle/Body/Enable` supprimées, ajout de `pushed/enabledToast/enabledToastDesc/directionTitle/directionBody/dir{From,To}{Title,Desc}` (fr + en).
- Vérifs : `tsc --noEmit` OK, `next lint` OK sur les fichiers touchés, JSON fr/en valides. Flux runtime non piloté (gated derrière l'auth AniList réelle) — logique/types/lint validés.

### Itération 2 — miroir strict, 3ᵉ option, popup = activation, déconnexion (retours user)
- **Bug du statut fantôme** (screenshots user) : le Hero affichait « Re-visionnage » (liste **locale**) alors que l'éditeur affichait « Pas dans la liste » (cache **AniList**). **Cause racine** : `fullSyncFromAniList` (resync de fond non-destructif) **conservait les entrées local-only** (absentes d'AniList) — une entrée `REPEATING` locale périmée survivait et contredisait AniList.
- **Fix « miroir strict »** (choix retenu via question) : quand sync est ON, AniList est **la seule source de vérité**. Les entrées local-only sont désormais **abandonnées** au resync (plus de carry-over lignes 155-158). La progression locale en avance reste défendue via `reconcileEntry` **mais uniquement** pour les anime présents aussi sur AniList (pas de « progression hors-ligne » pour un anime jamais sur AniList). L'entrée fantôme existante est purgée au prochain resync de fond. On **garde** le local comme cache résilient (offline) — il ne peut simplement plus contredire AniList.
- **3ᵉ option « Ne pas synchroniser »** : `SyncDirection` devient `"fromAniList" | "toAniList" | "off"`. Bouton dans le modal + gestion dans `_app` et `settings`.
- **Revirement : la popup EST l'activation** (avant : auto-`enabled:true` + toast dès la connexion, puis popup). Désormais le 1er login **ouvre la popup sans rien activer** ; choisir un sens active la sync (+ toast), « Ne pas synchroniser » la laisse off. → `DEFAULT_SYNC_PREFS.enabled` repasse à **`false`** (avant `true`) : plus aucune sync silencieuse pour un invité/indécis, et « off » devient un choix collant. Le `directionChosen` est ce qui gate le resync de fond (inchangé).
- **Déconnexion → sync OFF** : l'effet de `SyncBootstrap` détecte `!isConnected` et remet `enabled:false` **+ `directionChosen:false`** (reset) → une reconnexion re-pose la question. Écriture gardée (`if p.enabled || p.directionChosen`) pour ne pas spammer un `storage` event à chaque render, et no-op pour un invité pur.
- **Piège** : `SyncBootstrap` vit **dans** `<SessionProvider>` (déjà le cas) et l'effet ne dépend plus de `t` (retiré des deps une fois le toast déplacé hors de l'effet).
- Vérifs : `tsc --noEmit` OK, `next lint` OK, JSON valides.

---

## 2026-07-03 — Player : autoplay fiable (multi-lecteurs) + bouton play one-shot + icônes OP/ED + menu uniformisé

Session de debug guidée par les logs console du user (captures d'écran successives). Le fond `UniversalPlayer.tsx`.

### Autoplay — la bonne stratégie et les vrais pièges
- **Merge distant conflictuel** au départ : `origin/dev` avait déjà `e4f1025`/`138a59e` (autoplay unmuted-first + fallback muted + gros bouton play). Résolu en **gardant la stratégie distante** + y greffant le fix remount (résolution live de `playerEl`, jamais capturé une fois).
- **Ordre CRUCIAL = muted-first, PUIS unmute** (pas l'inverse). Le piège : sans user-activation, Chrome n'émet **pas** de `NotAllowedError` sur un unmuted-first — il **résout `play()` puis PAUSE** l'élément (message console *« Unmuting failed and the element was paused because the user didn't interact… »*). Donc le `catch(NotAllowedError)` ne fire jamais → on croit jouer alors que c'est en pause. → On joue **muté** (toujours accepté, jamais pausé), puis on tente `muted=false`, et si `video.paused` repasse à true (mitigation, **asynchrone** — vérifier après 2 `requestAnimationFrame`), on re-mute + relance + `unmutePending` (unmute au 1er geste).
- **Bug « change de lecteur → pas d'autoplay »** : l'effet marquait `started=true` dès `!video.paused`. Or un `play()` en vol sur un élément `readyState:0` reporte `paused=false` un instant → faux positif → l'`AbortError` (« play() interrupted by a new load », swap de source hls.js sur fallback Sibnet) n'était jamais rejoué. **Fix** : ne latch `started` que si `!paused && readyState>=2` (frame réelle). L'`AbortError` ne latch rien → le poll/events rejouent sur la nouvelle source.
- **Bug « activer l'autoplay en cours ne lance rien »** : la garde `currentTime>1 → return` bloquait une vidéo **en pause** que le user venait d'activer. **Fix** : la garde ne s'applique plus qu'à une vidéo **qui joue déjà** (`currentTime>1 && !video.paused`). Une vidéo en pause au-delà de 1s = demande de lancement légitime.
- **Poll auto-réparant** : un seul `setInterval` (100ms, plafond ~10s) qui, à chaque tick, (re)bind les events `canplay/loadeddata/loadstart` sur le **`<video>` courant** (pas le conteneur Vidstack, recréé au switch) et rappelle `tryPlay`. Guard `inFlight` pour ne pas chevaucher les `play()`. Court-circuit des sources **iframe/embed** (`streamData.iframe` sans clientExtract vidmoly) : pas de `<video>` à piloter, l'autoplay dépend du `allow` de l'iframe (megaplay marche seul).
- **Diagnostic** : `NEXT_PUBLIC_DEBUG_SOURCE=1` dans `.env.local` (gitignored) active `dwarn`. Pour du debug ponctuel j'ai utilisé des `console.log` inconditionnels colorés `[AP]` — **retirés avant push**. Les `dwarn` sont client-side (console navigateur), pas dans le log du dev server.
- **« Ne marche pas pour tous les lecteurs »** : diagnostic par logs = ce n'est PAS l'autoplay. vidmoly → `play() OK` avec son ✅. Certains (mewstream/sibnet) → **flux 403 / hlsError** = le CDN refuse le stream, pas de vidéo à lancer. **Chantier séparé** (extraction de source), hors autoplay.

### Bouton play central — one-shot
- Ne s'affiche QUE si **autoplay OFF** (`if (autoplay) return null`) — avec autoplay ON la vidéo part seule.
- **One-shot** : latch `everStarted` (via `useEffect` sur `!paused`) → une fois la lecture commencée, le gros bouton disparaît **définitivement** ; les pauses suivantes utilisent le petit play/pause en bas à gauche. (Avant : réapparaissait à chaque pause.)

### Icônes OP / ED (menu Automatisation)
- Les lignes « Passer l'intro/outro » partageaient l'icône `fast_forward`. Remplacées par des **badges OP / ED** (concept #3 choisi par le user via artifact de 5 propositions) : `<rect>` arrondi outline + `<text>` monogramme, `currentColor` (passe accent quand actif).
- `SettingsToggleRow` gagne une prop optionnelle **`iconNode`** (SVG multi-éléments) en plus de `iconPath` (single path). `iconNode` prime. **Labels inchangés** (demande explicite du user).

### Menu Settings — uniformisation + fix ambient
- **Lignes injectées trop petites/serrées** vs items natifs (Vitesse/Qualité) : le `style` inline ne reprenait pas la hauteur/padding/font-size natifs. **Fix CSS** : classe `.as-menu-row` (globals.css) pinnant `min-height: var(--media-menu-item-height,40px)`, `padding: 0 12px`, `font-size: var(--media-menu-font-size,15px)`, appliquée à `SettingsToggleRow`/`SettingsActionRow`/`SettingsSubmenuRow`/`SettingsSubmenuHeader`.
- **« Lumières d'ambiance » disparaissait en sous-menu Automatisation** : il n'était rendu que dans la branche `else` (menu principal), et le sous-panneau remplace toute la liste. **Fix** : « Lumières d'ambiance » désormais **épinglé en tête du sous-panneau** aussi (rendu dans la branche `automationOpen` avant le header retour).

---

## 2026-07-02 (suite 3) — Player : gros bouton play central + autoplay

- **Bouton play central** (`CenterPlayButton` dans `UniversalPlayer.tsx`) : visible quand
  `paused && canPlay`, sibling du `<MediaPlayer>` (comme `SkipOverlay`), z-index 15, container
  pointer-events-none / bouton pointer-events-auto. Clic = **démarre AVEC son** (unmute sauf mute
  intentionnel). Style : 56px, fond accent `#E94560` + glow (comme les boutons play de l'app) —
  1re version (80px, cercle noir translucide) jugée hors-style + trop grosse par le user.
- **Autoplay — itérations** :
  - v1 : `muted=true` puis `play()` → toujours OK mais « play et mute » (rejeté).
  - v2 : unmuted-first, **pas de fallback muted** → sur navigateur qui bloque, la vidéo **ne
    démarrait pas du tout** (rejeté : « ne lit pas la vidéo automatiquement »).
  - **v3 (retenu)** : unmuted-first → si `NotAllowedError`, **fallback MUTED** (toujours autorisé,
    la vidéo démarre) → **unmute au 1er geste** utilisateur (pointerdown/keydown/touchstart, capture
    +passive, ne perturbe pas le toggle Vidstack). Mute intentionnel respecté. Latch `started` pour
    ne pas relancer à chaque re-buffer.
- **Pourquoi pas l'attribut HTML `autoplay` ?** (question user) : même politique navigateur (bloqué
  ou muet sans geste/MEI, exactement comme `play()`), et il fire avant que hls.js n'ait attaché la
  source → déclenche la mitigation « Unmuting failed » de Chrome qui laisse le player en pause (déjà
  documenté ligne ~3199 : on ne passe PAS `autoplay` à Vidstack). L'approche JS fait strictement
  mieux (muted-fallback + unmute-au-geste, impossible avec l'attribut seul).

---
