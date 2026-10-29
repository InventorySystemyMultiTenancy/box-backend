import { Router } from "express";
import { requireAuth, requireRole, type AuthedRequest } from "@/middleware/auth";
import { connect, disconnect, getConnection, handleWebhook, isValidWebhookToken, WhatsappError } from "@/services/whatsapp.service";

// Conexão do número enviador (aba Usuários, só admin) e webhook das respostas SAIR/VOLTAR.
// A configuração (chave, instância, números da equipe) vem das variáveis de ambiente.
export const whatsappRouter = Router();

// URL pública do backend (para a Evolution chamar o webhook das respostas).
const publicUrl = (req: AuthedRequest) => process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;

whatsappRouter.get("/connection", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  res.json(await getConnection());
});

whatsappRouter.post("/connect", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest, res) => {
  try {
    res.json(await connect(publicUrl(req)));
  } catch (err) {
    if (err instanceof WhatsappError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

whatsappRouter.post("/disconnect", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    res.json(await disconnect());
  } catch (err) {
    if (err instanceof WhatsappError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// A Evolution chama aqui a cada mensagem recebida; o token secreto vai na URL. Sempre 200
// para ela não ficar repetindo.
whatsappRouter.post("/webhook/:token", async (req, res) => {
  if (!isValidWebhookToken(req.params.token)) return res.status(404).json({ error: "Não encontrado." });
  try {
    await handleWebhook(req.body);
  } catch (err) {
    console.error("[whatsapp] webhook:", (err as Error).message);
  }
  res.json({ ok: true });
});
