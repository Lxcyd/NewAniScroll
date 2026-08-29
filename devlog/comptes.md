# DEVLOG — Comptes, identite & sauvegarde des donnees

Les comptes AniScroll : identite invitee, compte propre, lien AniList, et la
sauvegarde serveur des donnees du visiteur. Couvre `lib/auth/*`,
`lib/db/turso-users.ts`, `lib/prefs/guestIdentity.ts`, `lib/list/cloudSync.ts`,
`pages/api/v2/account/*`, `components/auth/*` et l'onglet Users de l'admin.

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

## 2026-08-30 — Trois etats d'identite, et l'invite qui n'existe pas en base

**Le point de depart** : AniScroll n'avait aucun compte propre. La seule
identite etait la session NextAuth AniList (JWT, sans adaptateur), et *toutes*
les donnees du visiteur vivaient en `localStorage` — liste, progression, file
d'attente, une vingtaine de cles de reglages, plus les cles heritees du lecteur.
Vider le cache = tout perdre. Un `UserProfile` Postgres/Prisma survivait de
Moopa, utilise par trois fichiers, avec deux trous de securite dedans.

**Ce qui est en place** — trois etats, une hierarchie explicite :

| Etat | Identite | Donnees |
| --- | --- | --- |
| Invite | UUID local, **aucune ligne en base** | localStorage seul |
| Compte AniScroll | `users.id` + `tag`, pseudo, e-mail, mot de passe scrypt | sauvegardees |
| AniList seul | `users.id` + `tag` + `anilist_id`, **sans e-mail** | sauvegardees |
| AniScroll + AniList | le compte AniScroll prime ; AniList = synchro de liste | idem |

### Les trois decisions qui portent le reste

**1. L'invite n'a pas de ligne en base.** La question posee etait « comment
savoir qu'un compte invite ne sert plus, sans supprimer le compte de
quelqu'un ». La reponse n'est pas une politique de purge plus fine : c'est de
ne rien ecrire du tout. Un invite est un UUID dans son propre navigateur
(`lib/prefs/guestIdentity.ts`), et le probleme de la purge disparait au lieu
d'etre resolu. Corollaire pose en commentaire dans le fichier : l'unicite de cet
id n'a aucune importance, puisqu'il n'atteint jamais la base — a l'inscription
il est jete et le serveur frappe le sien (ULID + tag, `lib/auth/ids.ts`),
l'unicite venant de `PRIMARY KEY` / `UNIQUE` et **jamais** du client.

**2. Le `tag` est l'identite, le pseudo n'est qu'un affichage.** Six hex
publics par compte. C'est ce qui rend le cas « AniList seul » sur : quelqu'un
qui se connecte uniquement par AniList ne peut pas entrer en collision avec un
compte AniScroll qui aurait deja pris ce pseudo, parce que ce n'est pas le
pseudo qui l'identifie.

**3. Contrainte decouverte : l'API AniList n'expose pas d'e-mail.**
Introspection du type `User` : `id, name, about, avatar, bannerImage, options,
mediaListOptions, favourites, statistics, siteUrl, donatorTier, moderatorRoles,
createdAt, updatedAt, previousNames`. Le plan initial disait « on recupere
l'adresse mail d'AniList » — elle n'existe pas. Un compte AniList seul reste
donc sans e-mail jusqu'au jour ou son proprietaire cree un compte AniScroll
par-dessus, ce qui tombe exactement sur la hierarchie voulue.

### Ce qui a ete refuse

- **bcrypt / argon2** : binaire natif a compiler pour la lambda. `scrypt` de
  `node:crypto` (N=16384, r=8, p=1), parametres stockes dans le hash pour
  pouvoir les monter plus tard sans invalider l'existant. Zero dependance.
- **Upstash pour la limitation de debit** : le plafond gratuit (~500 k
  commandes/mois) est deja le budget le plus tendu du site, et les tentatives
  de connexion sont precisement le trafic non borne qui le ferait sauter. La
  table `auth_throttle` vit en Turso, et elle echoue **ouverte** : une
  fonctionnalite de compte qui n'atteint plus sa base est deja cassee, enfermer
  tout le monde dehors par-dessus n'aide personne.
- **Une route POST de liaison AniList** : elle prendrait un `anilist_id` dans
  le corps, donc n'importe qui reclamerait le compte AniList d'un autre. La
  liaison se fait dans le callback OAuth, la ou l'identite est prouvee ; la
  route ne garde que le `DELETE`.
- **Sauvegarder les favoris** : ils vivent sur AniList, qui les persiste deja.
  La categorie `favourites` est declaree mais sans cle locale a lire — la
  sauvegarder serait dupliquer une donnee qui n'est pas perdue au nettoyage du
  cache.

### Le conflit est arbitre PAR CATEGORIE

`user_data` porte une ligne par (utilisateur, categorie) avec une revision.
Un appareil qui n'a touche que les reglages du lecteur pousse `player` sans
rien dire de la liste qu'il n'a pas vue. `cloudSync.pullAll()` applique tout ce
qui est sans ambiguite (rien en local, ou revision serveur qui a avance pendant
que le local ne bougeait pas) et ne demande d'arbitrage que sur les categories
qui ont bouge **des deux cotes** — c'est le seul cas ou `CloudMergeModal`
s'ouvre. La fonction n'ecrase jamais silencieusement.

`cloudSync` est un **abonne**, pas une reecriture : chaque store emettait deja
son CustomEvent, donc aucun store existant n'a ete modifie. Et il est
independant de `lib/list/syncEngine.ts` : AniList possede la liste, nous
possedons la sauvegarde de l'appareil, les deux tournent sans se connaitre.

### Les deux trous de securite fermes au passage

`pages/api/user/profile.js` et `pages/api/user/update/episode.js` (heritage
Moopa) lisaient `name` depuis le corps ou la requete **sans le comparer a
`session.user.name`** sur les branches GET et PUT : tout utilisateur connecte
pouvait lire ou ecraser le profil et la progression d'un autre. Pire, un
`GET /api/user/profile` **sans** `name` tombait sur un `findMany` et renvoyait
*tous* les profils avec leur historique. Les deux routes prennent desormais
leur identite de la session et de nulle part ailleurs, et `getUser(null)`
renvoie `null` au lieu de tout deballer.

### Notes d'exploitation

- Nouvelle base Turso `aniscroll-users`, troisieme du site. `ensureUsersSchema()`
  cree les tables au premier appel : pas d'etape de migration.
- Tout degrade proprement quand `TURSO_USERS_URL` manque : les comptes sont
  simplement inactifs, le site continue en local seul. Idem pour
  `RESEND_API_KEY` : les liens partent dans les logs au lieu de la boite mail,
  ce qui permet de derouler l'inscription complete sur un deploiement preview.
- `isAdminSession` accepte maintenant `role === 'admin'` en base **en plus** de
  `NEXT_PUBLIC_ADMIN_USERNAMES` : rien de ce qui marchait ne s'arrete.
