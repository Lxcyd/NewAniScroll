#!/bin/sh
# `ignoreCommand` de Vercel : decide si ce commit merite un deploiement.
#
# Convention Vercel, contre-intuitive : sortir 0 = ANNULER le build, sortir 1 =
# le lancer.
#
# Pourquoi ca existe : un commit qui ne touche qu'au devlog, au changelog ou a
# un script d'outillage produit exactement le meme site — et pourtant il ecrit
# un bundle complet dans Functions Storage et Deployment Storage (10 Go chacun
# sur Hobby). Le 11/09/2026 ces deux plafonds ont ete creves et le compte est
# passe en pause. Ce filtre est le seul des garde-fous a agir cote Vercel
# plutot que cote poste de travail : il tient meme pour un push qui vient
# d'ailleurs (interface GitHub, autre machine, CI).
#
# EN CAS DE DOUTE, ON CONSTRUIT. Un deploiement de trop coute du quota ; un
# deploiement manquant fait croire a l'utilisateur que son correctif est en
# ligne alors qu'il ne l'est pas — c'est bien pire, et c'est exactement le
# piege dans lequel on est tombe le 12/09 (trois commits jamais deployes, une
# verification qui cherchait un bug inexistant).

# Chemins qui ne changent RIEN au site servi.
INERTES='^(devlog/|changelog/|tools/|scripts/|\.github/|\.githooks/|[^/]*\.md$)'

# Sans historique (clone superficiel, premier commit), on ne peut pas comparer :
# on construit.
git rev-parse HEAD^ >/dev/null 2>&1 || exit 1

FICHIERS=$(git diff --name-only HEAD^ HEAD 2>/dev/null) || exit 1

# Diff vide (merge sans changement, commit vide) : on construit, par prudence.
[ -z "$FICHIERS" ] && exit 1

# Au moins un fichier hors de la liste inerte -> ce commit change le site.
if printf '%s\n' "$FICHIERS" | grep -qvE "$INERTES"; then
  exit 1   # construire
fi

echo "[quota-guard] commit sans effet sur le site — build annule."
exit 0     # annuler
