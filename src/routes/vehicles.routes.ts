import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { getVehicleHistory, listRevisionAlerts, VehicleHistoryError } from "@/services/vehicle-history.service";

export const vehiclesRouter = Router();

// Rotas estáticas antes de "/:id" para não colidir com o param.
vehiclesRouter.get("/revision-alerts", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const alerts = await listRevisionAlerts();
  res.json({ alerts });
});

vehiclesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const vehicles = await prisma.vehicle.findMany({
    where: isStaff ? {} : { ownerId: req.user!.id },
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
});

vehiclesRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = createVehicleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.create({
    data: { ...parsed.data, ownerId: req.user!.id },
  });
  res.status(201).json({ vehicle });
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
