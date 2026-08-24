import fs from "fs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import { getVehicleHistory, listRevisionAlerts, VehicleHistoryError } from "@/services/vehicle-history.service";
import { recognizeVehicleFromImage, VehicleRecognitionError } from "@/services/vehicle-recognition.service";

export const vehiclesRouter = Router();

// Rotas estáticas antes de "/:id" para não colidir com o param.
vehiclesRouter.get("/revision-alerts", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const alerts = await listRevisionAlerts();
  res.json({ alerts });
});

// Foto do veículo lida por IA (marca/modelo/placa + danos visíveis) — usado ao abrir
// um novo projeto sem solicitação prévia. Não grava nada, só devolve os dados lidos
// para o admin conferir/editar antes de cadastrar; a imagem em si não é retida.
vehiclesRouter.post(
  "/recognize",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie uma foto do veículo." });

    try {
      const recognized = await recognizeVehicleFromImage(req.file.path, req.file.mimetype);
      res.json({ recognized });
    } catch (err) {
      if (err instanceof VehicleRecognitionError) return res.status(err.status).json({ error: err.message });
      throw err;
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
);

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

  const vehicle = await prisma.vehicle.update({ where: { id: req.params.id }, data: parsed.data });
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
