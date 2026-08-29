import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";

import { createUser, deleteUser, getUser, updateUser } from "@/prisma/user";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (session) {
    // Signed in.
    //
    // The identity comes from the SESSION, never from the request: every
    // branch below used to take `name` from the body or the query, so any
    // signed-in visitor could read, edit or wipe someone else's profile.
    // These routes are legacy (Prisma/Postgres, superseded by
    // /api/v2/account/*) — pinning them to the session is the cheap fix.
    const name = session.user?.name;
    if (!name) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      switch (req.method) {
        case "POST": {
          const new_user = await createUser(name);
          if (!new_user) {
            return res.status(200).json({ message: "User is already created" });
          } else {
            return res.status(201).json(new_user);
          }
        }
        case "PUT": {
          const { settings } = req.body;
          const user = await updateUser(name, settings);
          if (!user) {
            return res.status(200).json({ message: "Can't update settings" });
          } else {
            return res.status(200).json(user);
          }
        }
        case "GET": {
          const user = await getUser(name);
          if (!user) {
            return res.status(404).json({ message: "User not found" });
          } else {
            return res.status(200).json(user);
          }
        }
        case "DELETE": {
          const user = await deleteUser(name);
          if (!user) {
            return res.status(404).json({ message: "User not found" });
          } else {
            return res.status(200).json(user);
          }
        }
        default: {
          return res.status(405).json({ message: "Method not allowed" });
        }
      }
    } catch (error) {
      console.error("[user/profile]", error?.message || error);
      return res.status(500).json({ message: "Internal server error" });
    }
  } else {
    // Not Signed in
    res.status(401);
  }
  res.end();
}
