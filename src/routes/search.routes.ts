import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { getSearchAssistance, SearchAssistantError, SearchAssistTurn } from "@/services/search-assistant.service";
import { transcribeAudio, SpeechToTextError } from "@/services/speech-to-text.service";
import { upload } from "@/middleware/upload";
import fs from "fs";

export const searchRouter = Router();

// Busca global — cobre praticamente todo cadastro do sistema (OS, orçamentos,
// usuários/clientes, veículos, fornecedores, peças, caminhões e
// seguradoras), cada um com "contains" case-insensitive nos campos relevantes.
searchRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const empty = { orders: [], estimates: [], users: [], vehicles: [], suppliers: [], parts: [], trucks: [], insuranceCompanies: [] };
  if (q.length < 2) return res.json(empty);
  const contains = { contains: q, mode: "insensitive" as const };

  const [orders, estimates, users, vehicles, suppliers, parts, trucks, insuranceCompanies] = await Promise.all([
    prisma.serviceOrder.findMany({
      where: {
        OR: [
          { code: contains },
          { vehicle: { plate: contains } },
          { vehicle: { brand: contains } },
          { vehicle: { model: contains } },
          { vehicle: { owner: { name: contains } } },
          { insuranceCompany: { legalName: contains } },
          { insuranceCompany: { tradeName: contains } },
          { consultant: { name: contains } },
          { estimator: { name: contains } },
        ],
      },
      include: {
        vehicle: { include: { owner: { select: { id: true, name: true } } } },
        insuranceCompany: true,
        consultant: { select: { id: true, name: true } },
        estimator: { select: { id: true, name: true } },
        currentSector: true,
      },
      take: 25,
      orderBy: { createdAt: "desc" },
    }),
    prisma.estimate.findMany({
      where: { code: contains },
      include: { serviceOrder: { include: { vehicle: true } } },
      take: 25,
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { OR: [{ name: contains }, { email: contains }, { phone: contains }] },
      select: { id: true, name: true, email: true, phone: true, role: true },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.vehicle.findMany({
      where: {
        OR: [
          { brand: contains },
          { model: contains },
          { plate: contains },
          { chassi: contains },
          { renavam: contains },
          { owner: { name: contains } },
        ],
      },
      include: { owner: { select: { id: true, name: true } } },
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prisma.supplier.findMany({
      where: { OR: [{ name: contains }, { cpfCnpj: contains }, { contactName: contains }, { phone: contains }, { email: contains }] },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.inventoryPart.findMany({
      where: { OR: [{ name: contains }, { sku: contains }, { description: contains }] },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.truck.findMany({
      where: { OR: [{ plate: contains }, { brand: contains }, { model: contains }] },
      take: 10,
      orderBy: { plate: "asc" },
    }),
    prisma.insuranceCompany.findMany({
      where: { OR: [{ legalName: contains }, { tradeName: contains }] },
      take: 10,
      orderBy: { legalName: "asc" },
    }),
  ]);

  // Mecânico não vê valores em nenhuma outra tela (ver hidePricesForMechanic e
  // GET /inventory-parts) — a busca segue a mesma regra.
  if ((req as AuthedRequest).user!.role === "MECHANIC") {
    return res.json({
      orders: orders.map((o) => ({ ...o, estimatedMin: null, estimatedMax: null, deliveryExtraValue: null, deductibleAmount: null })),
      estimates: estimates.map((e) => ({
        ...e,
        laborTotal: null,
        partsTotal: null,
        materialsTotal: null,
        thirdPartyTotal: null,
        discountAmount: null,
        taxAmount: null,
        deductibleAmount: null,
        totalAmount: null,
      })),
      users,
      vehicles,
      suppliers,
      parts: parts.map((p) => ({ ...p, unitCost: null })),
      trucks,
      insuranceCompanies,
    });
  }

  res.json({ orders, estimates, users, vehicles, suppliers, parts, trucks, insuranceCompanies });
});

// Assistente por IA — chamado pelo front só quando a busca acima não encontra nada
// (ou quando a pergunta já veio de uma conversa em andamento), pra sugerir um termo
// alternativo, apontar pra uma aba do sistema, ou continuar o papo. Mesmo provedor de
// IA já usado nas leituras de foto (OPENAI_API_KEY), só que aqui é texto puro.
searchRouter.post("/assist", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const q = typeof req.body?.q === "string" ? req.body.q.trim() : "";
  if (q.length < 2) return res.status(400).json({ error: "Termo de busca inválido." });
  // Aba de onde a pessoa perguntou (ver submitHeaderSearch no front) — dá contexto pra
  // perguntas tipo "o que é essa aba?" sem precisar que ela nomeie a aba.
  const currentPath = typeof req.body?.currentPath === "string" ? req.body.currentPath.trim() : undefined;
  // Turnos anteriores da conversa (ver chat da página /dashboard/busca) — permite
  // reformular ou corrigir o que a IA respondeu antes ("não era isso, me ajude com...").
  const rawHistory: unknown[] = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: SearchAssistTurn[] = rawHistory
    .filter(
      (h): h is { role: unknown; content: unknown } =>
        !!h && typeof h === "object" && "role" in h && "content" in h && typeof (h as { content: unknown }).content === "string"
    )
    .map((h) => ({
      role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: (h.content as string).slice(0, 2000),
    }))
    .slice(-20);

  try {
    const assistance = await getSearchAssistance(q, currentPath, history);
    res.json(assistance);
  } catch (err) {
    if (err instanceof SearchAssistantError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Transcrição de áudio pro botão de microfone da busca/chat de ajuda — a pessoa fala,
// o áudio vira texto aqui, e o texto segue o fluxo normal de busca/assistente. O
// arquivo é só de passagem: nunca é salvo (Cloudinary/uploads), sempre apagado depois.
searchRouter.post("/transcribe", requireAuth, requireRole("MECHANIC", "ADMIN"), upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie um áudio." });

  try {
    const text = await transcribeAudio(req.file.path, req.file.mimetype, req.file.originalname);
    res.json({ text });
  } catch (err) {
    if (err instanceof SpeechToTextError) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    fs.promises.unlink(req.file.path).catch(() => {});
  }
});
