import fs from "fs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import { canSeeAlertType, canSeeSection, getReportAccess } from "@/lib/report-access";
import { getVehicleHistory, listRevisionAlerts, VehicleHistoryError } from "@/services/vehicle-history.service";
import { recognizeVehicleFromImage, VehicleRecognitionError } from "@/services/vehicle-recognition.service";
import { lookupPlate, normalizePlate } from "@/services/plate-lookup.service";
import { recordAudit } from "@/services/audit.service";

export const vehiclesRouter = Router();

// Rotas estáticas antes de "/:id" para não colidir com o param.
// Usado pelo bloco "Revisão preventiva" da aba Relatórios e pelos lembretes da aba Alertas —
// o cargo precisa ter um dos dois liberado.
vehiclesRouter.get("/revision-alerts", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const access = await getReportAccess(req.user!.id);
  if (!canSeeSection(access, "revision") && !canSeeAlertType(access, "REVISION_REMINDER")) {
    return res.status(403).json({ error: "Seu cargo não tem acesso à revisão preventiva." });
  }
  const alerts = await listRevisionAlerts();
  res.json({ alerts });
});

// Foto do veículo lida por IA (marca/modelo/placa + danos visíveis) — usado ao abrir
// um novo projeto sem solicitação prévia. Não grava nada, só devolve os dados lidos
// para o admin conferir/editar antes de cadastrar; a imagem em si não é retida. Com placa
// legível, consulta a placa na base externa (plate-lookup.service) e os dados de lá
// (marca/modelo/ano/cor) prevalecem sobre o palpite da IA, que é só pela aparência.
vehiclesRouter.post(
  "/recognize",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie uma foto do veículo." });

    try {
      const ai = await recognizeVehicleFromImage(req.file.path, req.file.mimetype);
      const plate = normalizePlate(ai.plate);
      const lookup = plate ? await lookupPlate(plate) : { status: "INVALID_PLATE" as const, result: null };
      const found = lookup.result;
      const recognized = {
        ...ai,
        plate: plate ?? ai.plate,
        brand: found?.brand ?? ai.brand,
        model: found?.model ?? ai.model,
        year: found?.modelYear ?? found?.year ?? ai.year,
        color: found?.color ?? ai.color,
        plateLookupStatus: lookup.status,
        plateLookup: found,
      };
      res.json({ recognized });
    } catch (err) {
      if (err instanceof VehicleRecognitionError) return res.status(err.status).json({ error: err.message });
      throw err;
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
);

// Consulta de placa digitada à mão (botão "Consultar placa" do novo projeto).
vehiclesRouter.get("/plate/:plate", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ plate: string }>, res) => {
  const lookup = await lookupPlate(req.params.plate);
  res.json({ status: lookup.status, result: lookup.result });
});

vehiclesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const ownerId = isStaff && typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const vehicles = await prisma.vehicle.findMany({
    where: isStaff ? { ...(ownerId ? { ownerId } : {}) } : { ownerId: req.user!.id },
    include: { owner: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ vehicles });
});

const createVehicleSchema = z.object({
  brand: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().min(1950).max(2100),
  engine: z.string().optional(),
  plate: z.string().optional(),
  mileage: z.number().int().min(0).default(0),
  chassi: z.string().optional(),
  renavam: z.string().optional(),
  color: z.string().optional(),
  fuelType: z.string().optional(),
  version: z.string().optional(),
  // Só staff pode cadastrar veículo em nome de outro cliente (ex.: abrir um projeto
  // novo direto pelo admin) — cliente comum sempre cadastra só o próprio veículo.
  ownerId: z.string().optional(),
});

vehiclesRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = createVehicleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const { ownerId, ...rest } = parsed.data;
  const vehicle = await prisma.vehicle.create({
    data: { ...rest, ownerId: isStaff && ownerId ? ownerId : req.user!.id },
  });
  res.status(201).json({ vehicle });
});

vehiclesRouter.patch("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = createVehicleSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const existing = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Veículo não encontrado." });

  // Funcionário (não-admin) só edita veículo de projeto em que está associado — mesma regra
  // de acesso aos projetos. Corrigir placa/dados errados é feito de dentro do projeto.
  if (req.user!.role === "MECHANIC") {
    const assigned = await prisma.serviceOrder.count({ where: { vehicleId: existing.id, assignees: { some: { userId: req.user!.id } } } });
    if (!assigned) return res.status(403).json({ error: "Sem acesso a este veículo." });
  }

  const vehicle = await prisma.vehicle.update({ where: { id: req.params.id }, data: parsed.data });
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entity: "Vehicle", entityId: vehicle.id, before: existing, after: vehicle });
  res.json({ vehicle });
});

vehiclesRouter.get("/:id", requireAuth, async (req: AuthedRequest<{ id: string }>, res) => {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) return res.status(404).json({ error: "Veículo não encontrado." });

  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  if (!isStaff && vehicle.ownerId !== req.user!.id) {
    return res.status(403).json({ error: "Este veículo não pertence a você." });
  }
  res.json({ vehicle });
});

vehiclesRouter.get("/:id/history", requireAuth, async (req: AuthedRequest<{ id: string }>, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  if (!isStaff) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
    if (!vehicle || vehicle.ownerId !== req.user!.id) {
      return res.status(403).json({ error: "Este veículo não pertence a você." });
    }
  }

  try {
    const history = await getVehicleHistory(req.params.id);
    res.json({ history });
  } catch (err) {
    if (err instanceof VehicleHistoryError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
