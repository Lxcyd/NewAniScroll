import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";

import {
  createList,
  deleteEpisode,
  deleteList,
  getEpisode,
  updateUserEpisode,
} from "@/prisma/user";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (session) {
    // Signed in.
    //
    // `name` comes from the SESSION on every branch. PUT and GET used to take
    // it from the body / query without comparing it to the session, so a
    // signed-in visitor could overwrite or read another account's watch
    // history. Legacy route (Prisma/Postgres), superseded by
    // /api/v2/account/sync — pinned rather than rewritten.
    const name = session.user?.name;
    if (!name) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      switch (req.method) {
        case "POST": {
          const { id } = JSON.parse(req.body);
          const episode = await createList(name, id);
          if (!episode) {
            return res
              .status(200)
              .json({ message: "Episode is already created" });
          } else {
            return res.status(201).json(episode);
          }
        }
        case "PUT": {
          const {
            id,
            watchId,
            title,
            image,
            number,
            duration,
            timeWatched,
            aniTitle,
            provider,
            nextId,
            nextNumber,
            dub,
          } = JSON.parse(req.body);
          const episode = await updateUserEpisode({
            name,
            id,
            watchId,
            title,
            image,
            number,
            duration,
            timeWatched,
            aniTitle,
            provider,
            nextId,
            nextNumber,
            dub,
          });
          if (!episode) {
            return res
              .status(200)
              .json({ message: "Episode is already there" });
          } else {
            return res.status(200).json(episode);
          }
        }
        case "GET": {
          const { id } = req.query;
          const episode = await getEpisode(name, id);
          if (!episode) {
            return res.status(404).json({ message: "Episode not found" });
          } else {
            return res.status(200).json(episode);
          }
        }
        case "DELETE": {
          const { id, aniId } = req.body;
          if (id) {
            const episode = await deleteEpisode(name, id);
            if (!episode) {
              return res.status(404).json({ message: "Episode not found" });
            } else {
              return res.status(200).json({ message: "Episode deleted" });
            }
          } else if (aniId) {
            const episode = await deleteList(name, aniId);
            if (!episode) {
              return res.status(404).json({ message: "Episode not found" });
            } else {
              return res.status(200).json({ message: "Episode deleted" });
            }
          }
        }
      }
    } catch (error) {
      console.error("[user/update/episode]", error?.message || error);
      return res.status(500).json({ message: "Internal server error" });
    }
  } else {
    // Not Signed in
    res.status(401).json({ message: "Unauthorized" });
  }
  res.end();
}
