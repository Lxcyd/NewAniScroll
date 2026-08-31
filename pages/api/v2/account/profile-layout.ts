import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { setProfileLayout } from "@/lib/auth/users";
import { isKnownBlock } from "@/lib/profile/blocks";
import { isValidLayout, sanitizeLayout } from "@/lib/profile/grid";

/**
 * PUT    → range la grille de widgets du compte connecté : `[{i,x,y,w,h}]`.
 * DELETE → la remet à la disposition par défaut.
 *
 * Elle est servie à TOUT visiteur du profil, exactement comme la bannière
 * (profile-banner.ts) : un profil se présente aux autres tel que son
 * propriétaire l'a rangé. C'est ce qui la sort de la catégorie `prefs`, où elle
 * appartenait au lecteur et où chaque visiteur voyait donc la sienne.
 *
 * Ce qui entre est nettoyé avant d'être écrit, et non pas seulement validé :
 * `sanitizeLayout` jette les identifiants inconnus et les doublons, borne
 * chaque rectangle dans la grille et recompacte. Une disposition arrive ici
 * depuis un navigateur, donc elle n'est jamais une donnée de confiance — et
 * celle-ci sera relue par d'autres que son auteur.
 *
 * Un invité n'a pas de compte et ne passe jamais par ici : /en/profile/me garde
 * sa disposition dans localStorage, à côté de la liste qu'il affiche.
 */
const MAX_BLOCKS = 40;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "DELETE") {
    await setProfileLayout(user.id, null);
    return res.status(200).json({ ok: true, layout: null });
  }

  if (req.method === "PUT") {
    const raw = req.body?.layout;
    if (!isValidLayout(raw) || raw.length > MAX_BLOCKS) {
      return res.status(400).json({ error: "layout" });
    }
    const layout = sanitizeLayout(raw, isKnownBlock);
    await setProfileLayout(user.id, JSON.stringify(layout));
    return res.status(200).json({ ok: true, layout });
  }

  return res.status(405).json({ error: "method" });
}
