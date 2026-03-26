export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  const { id, episode, sub = "sub" } = req.body;
  const embedUrl = `https://megaplay.buzz/stream/ani/${id}/${episode}/${sub}`;
  return res.status(200).json({ embedUrl });
}