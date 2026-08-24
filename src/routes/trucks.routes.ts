import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { upload, persistUploadedFile } from "@/middleware/upload";
import {
  listTrucks,
  listTrucksAssignedTo,
  getTruckDetail,
  createTruck,
  updateTruck,
  archiveTruck,
  startTrip,
  finishTrip,
  listTrips,
  TruckError,
} from "@/services/trucks.service";

export const trucksRouter = Router();

// Caminhões atribuídos ao usuário logado — usado pelo frontend pra decidir se ele
// enxerga a aba "Caminhões" mesmo não sendo admin.
trucksRouter.get("/assigned-to-me", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const trucks = await listTrucksAssignedTo(req.user!.id);
  res.json({ trucks });
});

trucksRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const trucks = req.user!.role === "ADMIN" ? await listTrucks() : await listTrucksAssignedTo(req.user!.id);
  res.json({ trucks });
});

trucksRouter.get("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const truck = await getTruckDetail(req.params.id);
    res.json({ truck });
  } catch (err) {
    if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const truckSchema = z.object({
  plate: z.string().min(4),
  brand: z.string().optional(),
  model: z.string().optional(),
  year: z.coerce.number().int().optional(),
  assignedEmployeeId: z.string().nullable().optional(),
  notes: z.string().optional(),
});

trucksRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = truckSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const truck = await createTruck(parsed.data);
    res.status(201).json({ truck });
  } catch (err) {
    if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

trucksRouter.patch("/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = truckSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const truck = await updateTruck(req.params.id, parsed.data);
    res.json({ truck });
  } catch (err) {
    if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

trucksRouter.delete("/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveTruck(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

trucksRouter.get("/:id/trips", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const trips = await listTrips(req.params.id);
  res.json({ trips });
});

const startTripSchema = z.object({
  startKm: z.coerce.number().int().min(0),
  startFuelLevel: z.string().min(1),
  startCondition: z.string().optional(),
});

trucksRouter.post(
  "/:id/trips/start",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = startTripSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    const startPhotoUrl = req.file ? await persistUploadedFile(req.file) : undefined;

    try {
      const trip = await startTrip(req.params.id, req.user!.id, req.user!.role, { ...parsed.data, startPhotoUrl });
      res.status(201).json({ trip });
    } catch (err) {
      if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);

const finishTripSchema = z.object({
  endKm: z.coerce.number().int().min(0),
  endFuelLevel: z.string().min(1),
  endCondition: z.string().optional(),
  notes: z.string().optional(),
});

// Foto de devolução é obrigatória — documenta o estado do caminhão e os veículos
// entregues dentro dele ao fim da pilotagem.
trucksRouter.patch(
  "/:id/trips/:tripId/finish",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string; tripId: string }>, res) => {
    const parsed = finishTripSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
    if (!req.file) return res.status(400).json({ error: "A foto de devolução é obrigatória." });

    const endPhotoUrl = await persistUploadedFile(req.file);

    try {
      const trip = await finishTrip(req.params.id, req.params.tripId, req.user!.id, req.user!.role, { ...parsed.data, endPhotoUrl });
      res.json({ trip });
    } catch (err) {
      if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);
