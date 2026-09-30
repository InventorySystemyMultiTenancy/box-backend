import { Router } from "express";
import { resolvePublicShareLink, ShareLinkError } from "@/services/share-link.service";

// Rotas sem requireAuth — de propósito. O token do link já é a própria autorização (só
// leitura, só daquela ordem específica); exigir login aqui derrotaria o motivo de o link
// existir (deixar quem não tem conta acompanhar o projeto).
export const publicRouter = Router();

publicRouter.get("/share/:token", async (req, res) => {
  try {
    const order = await resolvePublicShareLink(req.params.token);
    res.json({ order });
  } catch (err) {
    if (err instanceof ShareLinkError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
