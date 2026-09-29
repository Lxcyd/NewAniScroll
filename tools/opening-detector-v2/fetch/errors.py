"""Erreurs partagées par les couches qui lancent des sous-processus.

Vit à part pour une raison précise : `adapter_aniscroll` (le pont Node) et
`audio` (ffmpeg) doivent tous deux lever la MÊME exception, et l'un importe
déjà l'autre. Un module neutre est la seule façon d'éviter le cycle.
"""

from __future__ import annotations


class ProcessKilled(RuntimeError):
    """Le sous-processus a été TUÉ, il n'a pas échoué.

    Constaté le 08/08 : le lot top50 lancé à 01:50 est mort à 02:18 en
    laissant, sur ses 35 dernières lignes, les SIX hôtes en
    `bridge failed (rc=3221226091)` avec un stderr **vide**, au même instant.

    Ce code est **0xC000026B = STATUS_DLL_INIT_FAILED_LOGOFF**, et il dit
    littéralement la cause : Node n'a pas pu initialiser ses DLL *parce que la
    session Windows se fermait*. Le diagnostic n'est donc pas une déduction à
    partir de la simultanéité — le shell qui portait le lot a été fermé et tout
    le groupe de processus est parti avec lui. (Vérifier le code AVANT de
    conclure : je l'avais d'abord lu 0xC000041D de mémoire, ce qui aurait fait
    chercher une exception applicative là où il n'y avait qu'une déconnexion.)

    Pourquoi une classe à part plutôt qu'un `RuntimeError` de plus : aucun
    `_PERMANENT_MARKERS` ne correspondait, donc `_is_transient` la déclarait
    réessayable, le coupe-circuit fermait l'hôte pour le reste du lot, et les
    `except Exception` de `multi_host` la ravalaient en `hits = []`. Le lot
    CONTINUAIT alors à écrire des lignes — des absences imputées à des hôtes
    qui n'avaient rien fait de mal, indiscernables en base d'une vraie absence
    de générique.

    La règle qui en découle : une machine qui s'éteint ne produit pas de la
    donnée fausse mais crédible, elle arrête le lot.
    """


def killed_by_os(rc: int) -> bool:
    """La machine a-t-elle tué le processus, plutôt que celui-ci avoir échoué ?

    Deux signatures, dont aucune n'est atteignable par une sortie volontaire :
      - POSIX : `subprocess` rend l'opposé du numéro de signal, donc rc < 0.
      - Windows : le code de sortie EST le NTSTATUS, et les fatals commencent
        à 0xC0000000 (0xC000026B ici, 0xC0000005 pour une violation d'accès).
        Node comme ffmpeg sortent dans 0-255, la plage ne peut pas se croiser.
    """
    return rc < 0 or rc >= 0xC0000000
