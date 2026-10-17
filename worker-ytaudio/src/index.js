/**
 * aniscroll-ytaudio — la copie analysée de la musique du profil.
 *
 * Une seule route, `GET /a/<videoId>.mp4` (voir resolve.js). Worker SÉPARÉ du
 * proxy des épisodes (`worker/`) : un déploiement raté ici ne doit jamais
 * pouvoir casser la lecture des épisodes en production.
 */
import { handleAudio } from "./resolve.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    try {
      const res = await handleAudio(request, env, ctx);
      if (res) return res;
      return new Response("Not found", { status: 404, headers: CORS });
    } catch (err) {
      return new Response(JSON.stringify({ error: "ytaudio failed", detail: String(err) }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
  },
};
