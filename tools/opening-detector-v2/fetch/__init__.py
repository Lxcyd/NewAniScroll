"""Couche de telechargement, copiee telle quelle de la v1 (tools/opening-detector/oped).

C'est la seule partie de la v1 reprise : resolution d'un episode en flux
(bridge/resolve.mjs), cache HLS/MP4 local, decodage ffmpeg. Rien ici ne sait
ce qu'est un generique.
"""

SAMPLE_RATE = 11025  # Hz, mono : decode audio commun a tout le detecteur
