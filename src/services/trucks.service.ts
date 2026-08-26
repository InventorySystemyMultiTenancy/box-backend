import { prisma } from "@/lib/prisma";

export class TruckError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface TruckInput {
  plate: string;
  brand?: string;
  model?: string;
  year?: number;
  assignedEmployeeId?: string | null;
  notes?: string;
}

const truckInclude = {
  assignedEmployee: { select: { id: true, name: true, phone: true } },
  // Pilotagem em andamento (se houver) — evita N+1 no frontend pra saber se o
  // caminhão está disponível ou em uso.
  trips: {
    where: { status: "IN_PROGRESS" },
    take: 1,
    orderBy: { startedAt: "desc" as const },
    include: { driver: { select: { id: true, name: true } } },
  },
};

export async function listTrucks() {
  return prisma.truck.findMany({ where: { active: true }, include: truckInclude, orderBy: { plate: "asc" } });
}

// Caminhões em que o funcionário é o motorista designado — usado para liberar a
// aba "Caminhões" e a pilotagem para quem não é admin.
export async function listTrucksAssignedTo(userId: string) {
  return prisma.truck.findMany({ where: { active: true, assignedEmployeeId: userId }, include: truckInclude, orderBy: { plate: "asc" } });
}

export async function getTruckDetail(id: string) {
  const truck = await prisma.truck.findUnique({
    where: { id },
    include: { ...truckInclude, trips: { orderBy: { startedAt: "desc" }, include: { driver: { select: { id: true, name: true } } } } },
  });
  if (!truck) throw new TruckError("Caminhão não encontrado.", 404);
  return truck;
}

export async function createTruck(input: TruckInput) {
  const existing = await prisma.truck.findUnique({ where: { plate: input.plate } });
  if (existing) throw new TruckError("Já existe um caminhão com essa placa.", 409);
  return prisma.truck.create({ data: input, include: truckInclude });
}

export async function updateTruck(id: string, input: Partial<TruckInput>) {
  const truck = await prisma.truck.findUnique({ where: { id } });
  if (!truck) throw new TruckError("Caminhão não encontrado.", 404);
  return prisma.truck.update({ where: { id }, data: input, include: truckInclude });
}

export async function archiveTruck(id: string) {
  const truck = await prisma.truck.findUnique({ where: { id } });
  if (!truck) throw new TruckError("Caminhão não encontrado.", 404);
  const openTrip = await prisma.truckTrip.findFirst({ where: { truckId: id, status: "IN_PROGRESS" } });
  if (openTrip) throw new TruckError("Não é possível excluir um caminhão com pilotagem em andamento.", 409);
  await prisma.truck.update({ where: { id }, data: { active: false } });
}

function canOperate(truck: { assignedEmployeeId: string | null }, userId: string, role: string) {
  return role === "ADMIN" || truck.assignedEmployeeId === userId;
}

export interface StartTripInput {
  startKm: number;
  startFuelLevel: string;
  startCondition?: string;
  startPhotoUrl?: string;
}

export async function startTrip(truckId: string, userId: string, role: string, input: StartTripInput) {
  const truck = await prisma.truck.findUnique({ where: { id: truckId } });
  if (!truck || !truck.active) throw new TruckError("Caminhão não encontrado.", 404);
  if (!canOperate(truck, userId, role)) throw new TruckError("Você não está designado para este caminhão.", 403);

  const openTrip = await prisma.truckTrip.findFirst({ where: { truckId, status: "IN_PROGRESS" } });
  if (openTrip) throw new TruckError("Este caminhão já está em uso — finalize a pilotagem atual antes de iniciar outra.", 409);

  // Km não pode retroceder em relação à última pilotagem DESTE caminhão — cada
  // caminhão tem sua própria linha do tempo de km, então trocar de caminhão não
  // é bloqueado por essa checagem.
  const lastCompleted = await prisma.truckTrip.findFirst({
    where: { truckId, status: "COMPLETED" },
    orderBy: { endedAt: "desc" },
  });
  if (lastCompleted?.endKm != null && input.startKm < lastCompleted.endKm) {
    throw new TruckError(
      `A km informada (${input.startKm}) é menor que a última km registrada para este caminhão (${lastCompleted.endKm}).`,
      400
    );
  }

  return prisma.truckTrip.create({
    data: { truckId, driverId: userId, ...input },
    include: { truck: true, driver: { select: { id: true, name: true } } },
  });
}

export interface FinishTripInput {
  endKm: number;
  endFuelLevel: string;
  endCondition?: string;
  endPhotoUrl: string;
  notes?: string;
}

export async function finishTrip(truckId: string, tripId: string, userId: string, role: string, input: FinishTripInput) {
  const trip = await prisma.truckTrip.findUnique({ where: { id: tripId }, include: { truck: true } });
  if (!trip || trip.truckId !== truckId) throw new TruckError("Pilotagem não encontrada para este caminhão.", 404);
  if (trip.status !== "IN_PROGRESS") throw new TruckError("Esta pilotagem já foi finalizada.", 409);
  if (!canOperate(trip.truck, userId, role)) throw new TruckError("Você não está designado para este caminhão.", 403);
  if (input.endKm < trip.startKm) throw new TruckError("A km de devolução não pode ser menor que a km de início.", 400);

  return prisma.truckTrip.update({
    where: { id: tripId },
    data: { status: "COMPLETED", endedAt: new Date(), ...input },
    include: { truck: true, driver: { select: { id: true, name: true } } },
  });
}

export async function listTrips(truckId: string) {
  return prisma.truckTrip.findMany({
    where: { truckId },
    orderBy: { startedAt: "desc" },
    include: { driver: { select: { id: true, name: true } } },
  });
}

// Histórico de pilotagens/devoluções de todos os caminhões — aba "Movimentações".
// Admin vê tudo; demais usuários só veem os caminhões em que estão designados,
// espelhando o mesmo recorte já usado em listTrucksAssignedTo.
export async function listAllTripMovements(role: string, userId: string, take = 100) {
  return prisma.truckTrip.findMany({
    where: role === "ADMIN" ? {} : { truck: { assignedEmployeeId: userId } },
    orderBy: { startedAt: "desc" },
    take,
    include: {
      driver: { select: { id: true, name: true } },
      truck: { select: { id: true, plate: true, brand: true, model: true } },
    },
  });
}

// --- Abastecimentos ----------------------------------------------------------

const refuelingInclude = {
  driver: { select: { id: true, name: true } },
  truck: { select: { id: true, plate: true, brand: true, model: true } },
};

export interface RefuelingInput {
  photoUrl: string;
  currentKm: number;
  liters: number;
  amountPaid: number;
  pricePerLiter?: number;
  notes?: string;
}

export async function createRefueling(truckId: string, userId: string, role: string, input: RefuelingInput) {
  const truck = await prisma.truck.findUnique({ where: { id: truckId } });
  if (!truck || !truck.active) throw new TruckError("Caminhão não encontrado.", 404);
  if (!canOperate(truck, userId, role)) throw new TruckError("Você não está designado para este caminhão.", 403);
  if (input.liters <= 0) throw new TruckError("Litros abastecidos deve ser maior que zero.", 400);
  if (input.amountPaid <= 0) throw new TruckError("Valor pago deve ser maior que zero.", 400);

  const openTrip = await prisma.truckTrip.findFirst({ where: { truckId, status: "IN_PROGRESS" } });
  if (!openTrip) throw new TruckError("Este caminhão não tem uma pilotagem em andamento — inicie a pilotagem antes de lançar o abastecimento.", 409);

  // Referência do cálculo de consumo: km do abastecimento anterior NESTA pilotagem,
  // ou a km de início da pilotagem se este for o primeiro abastecimento dela.
  const lastRefueling = await prisma.truckRefueling.findFirst({
    where: { tripId: openTrip.id },
    orderBy: { createdAt: "desc" },
  });
  const referenceKm = lastRefueling ? lastRefueling.currentKm : openTrip.startKm;

  if (input.currentKm < referenceKm) {
    throw new TruckError(
      `A km informada (${input.currentKm}) é menor que a km de referência desta pilotagem (${referenceKm}).`,
      400
    );
  }

  const kmPerLiter = input.currentKm > referenceKm ? (input.currentKm - referenceKm) / input.liters : null;
  const pricePerLiter = input.pricePerLiter ?? input.amountPaid / input.liters;

  return prisma.truckRefueling.create({
    data: {
      truckId,
      tripId: openTrip.id,
      driverId: userId,
      photoUrl: input.photoUrl,
      currentKm: input.currentKm,
      referenceKm,
      liters: input.liters,
      amountPaid: input.amountPaid,
      pricePerLiter,
      kmPerLiter,
      notes: input.notes,
    },
    include: refuelingInclude,
  });
}

export async function listRefuelings(truckId: string) {
  return prisma.truckRefueling.findMany({ where: { truckId }, orderBy: { createdAt: "desc" }, include: refuelingInclude });
}

// Todos os abastecimentos de todos os caminhões — aba "Abastecimentos". Mesmo
// recorte de visibilidade das demais listagens de caminhão (admin vê tudo).
export async function listAllRefuelings(role: string, userId: string, take = 100) {
  return prisma.truckRefueling.findMany({
    where: role === "ADMIN" ? {} : { truck: { assignedEmployeeId: userId } },
    orderBy: { createdAt: "desc" },
    take,
    include: refuelingInclude,
  });
}

export interface ConsumptionAlert {
  type: "CONSUMO_ALTO" | "CONSUMO_BAIXO" | "PRECO_ACIMA_MEDIA";
  message: string;
}

// Compara este abastecimento com o histórico (consumo do mesmo caminhão, preço da
// frota inteira) para sinalizar desvios — não é gravado no banco, é calculado sob
// demanda e só deve ser exposto ao admin (a rota decide isso, não este service).
export async function getRefuelingAlerts(refueling: {
  id: string;
  truckId: string;
  kmPerLiter: number | null;
  pricePerLiter: number | null;
}): Promise<ConsumptionAlert[]> {
  const alerts: ConsumptionAlert[] = [];

  if (refueling.kmPerLiter != null) {
    const history = await prisma.truckRefueling.findMany({
      where: { truckId: refueling.truckId, id: { not: refueling.id }, kmPerLiter: { not: null } },
      select: { kmPerLiter: true },
    });
    if (history.length > 0) {
      const avg = history.reduce((sum, h) => sum + (h.kmPerLiter ?? 0), 0) / history.length;
      if (avg > 0) {
        if (refueling.kmPerLiter < avg * 0.75) {
          alerts.push({
            type: "CONSUMO_ALTO",
            message: `Consumo de ${refueling.kmPerLiter.toFixed(1)} km/l está bem abaixo da média deste caminhão (${avg.toFixed(1)} km/l) — pode indicar problema mecânico ou uso indevido.`,
          });
        } else if (refueling.kmPerLiter > avg * 1.25) {
          alerts.push({
            type: "CONSUMO_BAIXO",
            message: `Consumo de ${refueling.kmPerLiter.toFixed(1)} km/l acima da média deste caminhão (${avg.toFixed(1)} km/l) — ótima eficiência.`,
          });
        }
      }
    }
  }

  if (refueling.pricePerLiter != null) {
    const priceHistory = await prisma.truckRefueling.findMany({
      where: { id: { not: refueling.id }, pricePerLiter: { not: null } },
      select: { pricePerLiter: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    if (priceHistory.length > 0) {
      const avgPrice = priceHistory.reduce((sum, h) => sum + (h.pricePerLiter ?? 0), 0) / priceHistory.length;
      if (avgPrice > 0 && refueling.pricePerLiter > avgPrice * 1.15) {
        alerts.push({
          type: "PRECO_ACIMA_MEDIA",
          message: `Preço pago (R$ ${refueling.pricePerLiter.toFixed(2)}/l) está acima da média recente da frota (R$ ${avgPrice.toFixed(2)}/l).`,
        });
      }
    }
  }

  return alerts;
}
