"""Borne haute du taux d'erreur (intervalle de Wilson, 95 %).

0 erreur sur n cases servies ne prouve pas 0 % d'erreur : sur 100 cases, la
borne haute est 3,7 % ; il faut ~300 cases pour descendre sous 1,3 %.
"""
from __future__ import annotations

import math

Z95 = 1.959964


def upper(errors: int, n: int, z: float = Z95) -> float:
    if n == 0:
        return 1.0
    p = errors / n
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    marge = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre + marge) / den


def line(errors: int, n: int) -> str:
    return (f"{n - errors}/{n} justes, {errors} erreur(s) -> taux d'erreur <= "
            f"{100 * upper(errors, n):.1f} % (95 %)")
