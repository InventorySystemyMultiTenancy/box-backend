import fs from "fs";
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
  listAllTripMovements,
  createRefueling,
  listRefuelings,
  listAllRefuelings,
  getRefuelingAlerts,
  TruckError,
} from "@/services/trucks.service";
import { recognizeTruckPanel, recognizeFuelPump, TruckVisionError } from "@/services/truck-vision.service";

export const trucksRouter = Router();

// Anexa os alertas de consumo/preço só para o admin — mecânico vê seus próprios
// números (km/l, valor pago), mas não o julgamento ("consumo alto", "preço acima
// da média"), como pedido: "somente o admin deve ver esses alertas".
async function withAlertsForAdmin<T extends { id: string; truckId: string; kmPerLiter: number | null; pricePerLiter: number | null }>(
  refuelings: T[],
  role: string
): Promise<(T & { alerts?: Awaited<ReturnType<typeof getRefuelingAlerts>> })[]> {
  if (role !== "ADMIN") return refuelings;
  return Promise.all(
    refuelings.map(async (r) => ({ ...r, alerts: await getRefuelingAlerts(r) }))
  );
}

// Caminhões atribuídos ao usuário logado — usado pelo frontend pra decidir se ele
// enxerga a aba "Caminhões" mesmo não sendo admin.
trucksRouter.get("/assigned-to-me", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const trucks = await listTrucksAssignedTo(req.user!.id);
  res.json({ trucks });
});

// Histórico de pilotagens/devoluções de todos os caminhões (aba "Movimentações") —
// precisa vir antes de "/:id" para "movements" não ser interpretado como um id.
trucksRouter.get("/movements", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const trips = await listAllTripMovements(req.user!.role, req.user!.id);
  res.json({ trips });
});

// Todos os abastecimentos de todos os caminhões (aba "Abastecimentos") — também
// precisa vir antes de "/:id".
trucksRouter.get("/refuelings", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const refuelings = await listAllRefuelings(req.user!.role, req.user!.id);
  res.json({ refuelings: await withAlertsForAdmin(refuelings, req.user!.role) });
});

// Leitura por IA do painel do caminhão (hodômetro + combustível) — usada ao iniciar
// e ao finalizar a pilotagem para pré-preencher a km. Não grava nada, só devolve os
// dados lidos para o formulário; o arquivo temporário é sempre apagado depois.
trucksRouter.post(
  "/recognize-panel",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie uma foto do painel." });
    try {
      const recognized = await recognizeTruckPanel(req.file.path, req.file.mimetype);
      res.json({ recognized });
    } catch (err) {
      if (err instanceof TruckVisionError) return res.status(err.status).json({ error: err.message });
      throw err;
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
);

// Leitura por IA do visor da bomba de combustível — usada ao lançar um abastecimento
// para pré-preencher valor pago/litros/preço por litro.
trucksRouter.post(
  "/recognize-pump",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie uma foto da bomba de combustível." });
    try {
      const recognized = await recognizeFuelPump(req.file.path, req.file.mimetype);
      res.json({ recognized });
    } catch (err) {
      if (err instanceof TruckVisionError) return res.status(err.status).json({ error: err.message });
      throw err;
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
);

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

// Foto do painel é obrigatória — é a mesma foto que a IA lê (rota /recognize-panel)
// para sugerir a km de início antes do envio deste formulário.
trucksRouter.post(
  "/:id/trips/start",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = startTripSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
    if (!req.file) return res.status(400).json({ error: "A foto do painel do caminhão é obrigatória." });

    const startPhotoUrl = await persistUploadedFile(req.file);

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

trucksRouter.get("/:id/refuelings", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const refuelings = await listRefuelings(req.params.id);
  res.json({ refuelings: await withAlertsForAdmin(refuelings, req.user!.role) });
});

const refuelingSchema = z.object({
  currentKm: z.coerce.number().int().min(0),
  liters: z.coerce.number().positive(),
  amountPaid: z.coerce.number().positive(),
  pricePerLiter: z.coerce.number().positive().optional(),
  notes: z.string().optional(),
});

// Foto da bomba é obrigatória — é a mesma foto que a IA lê (rota /recognize-pump)
// para sugerir valor pago/litros antes do envio deste formulário.
trucksRouter.post(
  "/:id/refuelings",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = refuelingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
    if (!req.file) return res.status(400).json({ error: "A foto da bomba de combustível é obrigatória." });

    const photoUrl = await persistUploadedFile(req.file);

    try {
      const refueling = await createRefueling(req.params.id, req.user!.id, req.user!.role, { ...parsed.data, photoUrl });
      const [withAlerts] = await withAlertsForAdmin([refueling], req.user!.role);
      res.status(201).json({ refueling: withAlerts });
    } catch (err) {
      if (err instanceof TruckError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);
