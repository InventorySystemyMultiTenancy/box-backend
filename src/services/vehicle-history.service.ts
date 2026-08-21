import { prisma } from "@/lib/prisma";
import { REVISION_ALERT_MONTHS } from "@/lib/constants";

export class VehicleHistoryError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function monthsSince(date: Date) {
  const now = new Date();
  return (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
}

export async function getVehicleHistory(vehicleId: string) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      owner: { select: { id: true, name: true, phone: true } },
      serviceOrders: { orderBy: { receivedAt: "desc" } },
    },
  });
  if (!vehicle) throw new VehicleHistoryError("Veículo não encontrado.", 404);

  const orderIds = vehicle.serviceOrders.map((o) => o.id);
  const totalSpentResult = orderIds.length
    ? await prisma.accountReceivable.aggregate({
        where: { serviceOrderId: { in: orderIds }, status: "RECEIVED" },
        _sum: { receivedAmount: true },
      })
    : null;

  const lastServiceDate = vehicle.serviceOrders
    .map((o) => o.completedAt ?? o.receivedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const monthsSinceLastService = lastServiceDate ? monthsSince(lastServiceDate) : null;

  return {
    vehicle: { id: vehicle.id, brand: vehicle.brand, model: vehicle.model, year: vehicle.year, plate: vehicle.plate, mileage: vehicle.mileage, owner: vehicle.owner },
    serviceOrders: vehicle.serviceOrders,
    totalSpent: totalSpentResult?._sum.receivedAmount ?? 0,
    lastServiceAt: lastServiceDate ?? null,
    monthsSinceLastService,
    revisionDue: monthsSinceLastService !== null && monthsSinceLastService >= REVISION_ALERT_MONTHS,
  };
}

// Varre todos os veículos com pelo menos uma OS e sinaliza os que estão sem
// atendimento há REVISION_ALERT_MONTHS ou mais — usado para contato proativo.
export async function listRevisionAlerts() {
  const vehicles = await prisma.vehicle.findMany({
    include: {
      owner: { select: { id: true, name: true, phone: true } },
      serviceOrders: { select: { completedAt: true, receivedAt: true }, orderBy: { receivedAt: "desc" } },
    },
  });

  const alerts = vehicles
    .filter((v) => v.serviceOrders.length > 0)
    .map((v) => {
      const lastServiceDate = v.serviceOrders
        .map((o) => o.completedAt ?? o.receivedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const months = monthsSince(lastServiceDate);
      return {
        vehicle: { id: v.id, brand: v.brand, model: v.model, year: v.year, plate: v.plate },
        owner: v.owner,
        lastServiceAt: lastServiceDate,
        monthsSinceLastService: months,
      };
    })
    .filter((a) => a.monthsSinceLastService >= REVISION_ALERT_MONTHS)
    .sort((a, b) => b.monthsSinceLastService - a.monthsSinceLastService);

  return alerts;
}
