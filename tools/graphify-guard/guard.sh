# Garde-fou de charge pour les reconstructions graphify. A SOURCER, pas a lancer.
#
# POURQUOI. graphify reconstruit le graphe a chaque commit ET a chaque
# changement de branche, en detache. Sur Unix trois garde-fous bornent ca :
# un flock (une seule reconstruction a la fois), une alarme SIGALRM (600 s),
# et `os.nice` + `RLIMIT_AS`. Mesure du 20/09/2026 sur cette machine :
#
#   plateforme      : Windows
#   signal.SIGALRM  : absent   -> le delai de 600 s ne s'arme JAMAIS
#   module fcntl    : absent   -> le verrou est un no-op, sa propre docstring
#                                 le dit : « Falls back to a no-op yield(True)
#                                 on platforms without fcntl (Windows) »
#   module resource : absent   -> ni priorite basse, ni plafond memoire
#
# Les trois sont donc inertes ici, et `os.cpu_count()` vaut 24 : chaque
# reconstruction ouvre 24 processus d'extraction d'AST sur ~2 500 fichiers, et
# rien n'empeche plusieurs reconstructions de se superposer. Le journal le
# montrait noir sur blanc, deux passes entrelacees sur la meme ligne :
#
#   AST extraction: 100/2409 uncached files (4%) [24 workers]
#   AST extraction:   AST extraction: 100/2583 uncached files (3%) [24 workers]
#
# Une session de travail normale enchaine une quinzaine de commits et de
# bascules de branche. D'ou une machine qui rame au point qu'il faut la
# redemarrer.
#
# CE QUE CE FICHIER FAIT. Il retablit les trois bornes avec des moyens qui
# existent sur Windows :
#
#   1. Un verrou par REPERTOIRE. `mkdir` est atomique sur tous les systemes de
#      fichiers, la ou `flock` n'existe pas. Avec une echappatoire d'anciennete :
#      un verrou plus vieux que VERROU_PERIME_S vient forcement d'une
#      reconstruction tuee, et on le reprend plutot que de bloquer pour toujours.
#   2. Un PLAFOND de workers, via `GRAPHIFY_MAX_WORKERS` que graphify lit deja.
#      On laisse de la marge a la machine au lieu de prendre tous les coeurs.
#   3. Un ANTI-REBOND : au plus une reconstruction par DEBOUNCE_S. Vingt commits
#      d'affilee ne valent pas vingt reconstructions — le graphe n'est pas une
#      source de verite temps reel, il sert a localiser du code.
#
# CE QU'IL NE FAIT PAS. Il ne touche pas au code de graphify : une mise a jour
# de l'outil l'ecraserait. Il vit hors du bloc `# graphify-hook-start/end` des
# hooks, pour qu'un `graphify hook install` ne l'efface pas non plus.
#
# Pour le desactiver le temps d'une commande : ANISCROLL_GRAPHIFY_GUARD=0
# Pour forcer une reconstruction malgre l'anti-rebond : GRAPHIFY_FORCE=1

[ "${ANISCROLL_GRAPHIFY_GUARD:-1}" = "0" ] && return 0 2>/dev/null

# Un quart des coeurs, au moins 2. La reconstruction est plus longue, et c'est
# exactement le but : elle tourne en fond, personne ne l'attend.
if [ -z "${GRAPHIFY_MAX_WORKERS:-}" ]; then
  _coeurs=$(node -e "console.log(require('os').cpus().length)" 2>/dev/null || echo 4)
  _n=$((_coeurs / 4))
  [ "$_n" -lt 2 ] && _n=2
  GRAPHIFY_MAX_WORKERS="$_n"
  export GRAPHIFY_MAX_WORKERS
fi

# Plafond memoire : inerte sur Windows (pas de module `resource`), mais pose
# quand meme — la meme variable borne reellement la reconstruction sur les
# machines Unix de quiconque clone ce depot.
: "${GRAPHIFY_REBUILD_MEMORY_LIMIT_MB:=3072}"
export GRAPHIFY_REBUILD_MEMORY_LIMIT_MB

_VERROU="graphify-out/.garde-reconstruction"
VERROU_PERIME_S=1800
DEBOUNCE_S=600
_HORODATAGE="graphify-out/.derniere-reconstruction"

# 1. Verrou. `mkdir` echoue si le repertoire existe : c'est le test et la prise
#    en une seule operation atomique, sans course possible.
if ! mkdir "$_VERROU" 2>/dev/null; then
  _age=$(( $(date +%s) - $(date -r "$_VERROU" +%s 2>/dev/null || echo 0) ))
  if [ "$_age" -lt "$VERROU_PERIME_S" ]; then
    echo "[garde graphify] une reconstruction tourne deja (${_age}s) — on ne l'empile pas"
    return 0 2>/dev/null || exit 0
  fi
  echo "[garde graphify] verrou perime (${_age}s) — reprise"
  rm -rf "$_VERROU" 2>/dev/null
  mkdir "$_VERROU" 2>/dev/null || { return 0 2>/dev/null || exit 0; }
fi

# 2. Anti-rebond. Apres la prise du verrou, sinon deux hooks simultanes liraient
#    le meme horodatage et passeraient tous les deux.
if [ "${GRAPHIFY_FORCE:-}" != "1" ] && [ -f "$_HORODATAGE" ]; then
  _depuis=$(( $(date +%s) - $(date -r "$_HORODATAGE" +%s 2>/dev/null || echo 0) ))
  if [ "$_depuis" -lt "$DEBOUNCE_S" ]; then
    echo "[garde graphify] reconstruit il y a ${_depuis}s — on attend (seuil ${DEBOUNCE_S}s)"
    rmdir "$_VERROU" 2>/dev/null
    return 0 2>/dev/null || exit 0
  fi
fi
mkdir -p graphify-out 2>/dev/null
: > "$_HORODATAGE"

# 3. Le verrou doit etre rendu quand la reconstruction DETACHEE se termine, pas
#    quand le hook rend la main — il rend la main tout de suite. On confie donc
#    sa liberation a un veilleur detache, borne par la meme peremption pour
#    qu'un processus tue ne laisse jamais le verrou derriere lui.
(
  _fin=$(( $(date +%s) + VERROU_PERIME_S ))
  while [ "$(date +%s)" -lt "$_fin" ]; do
    sleep 20
    pgrep -f "graphify" >/dev/null 2>&1 || break
  done
  rm -rf "$_VERROU" 2>/dev/null
) >/dev/null 2>&1 &

echo "[garde graphify] reconstruction autorisee (${GRAPHIFY_MAX_WORKERS} workers)"
