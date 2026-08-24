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
