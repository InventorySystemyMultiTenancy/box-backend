import { prisma } from "@/lib/prisma";

/**
 * Um cliente só enxerga ordens de serviço de veículos que ele mesmo possui.
 * Mecânico/admin enxergam qualquer ordem — são quem opera o serviço.
 */
export async function canAccessServiceOrder(userId: string, role: string, serviceOrderId: string) {
  if (role === "MECHANIC" || role === "ADMIN") return true;

  const order = await prisma.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { vehicle: true },
  });
  return !!order && order.vehicle.ownerId === userId;
}
