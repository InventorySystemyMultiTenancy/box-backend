import { NextFunction, Response } from "express";
import { prisma } from "@/lib/prisma";
import { AuthedRequest } from "@/middleware/auth";

/**
 * Admin enxerga qualquer ordem. Funcionário (MECHANIC) só as ordens em que foi associado
 * (ServiceOrderAssignee — o admin associa; quem cria o projeto entra sozinho). Cliente só
 * as ordens de veículos que ele mesmo possui.
 */
export async function canAccessServiceOrder(userId: string, role: string, serviceOrderId: string) {
  if (role === "ADMIN") return true;

  if (role === "MECHANIC") {
    const assignment = await prisma.serviceOrderAssignee.findUnique({
      where: { serviceOrderId_userId: { serviceOrderId, userId } },
    });
    return !!assignment;
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { vehicle: true },
  });
  return !!order && order.vehicle.ownerId === userId;
}

/** Mesmo critério de canAccessServiceOrder, como filtro de listagem (where do Prisma). */
export function serviceOrderVisibilityFilter(userId: string, role: string) {
  if (role === "ADMIN") return {};
  if (role === "MECHANIC") return { assignees: { some: { userId } } };
  return { vehicle: { ownerId: userId } };
}

/**
 * Trava de acesso para tudo em /api/service-orders/:orderId/... (projeto, etapas, peças,
 * aprovações, chat, fotos) — montada no app.ts antes dos routers da OS. Roda depois do
 * requireAuth; as rotas continuam aplicando requireRole por conta própria.
 */
export async function requireServiceOrderAccess(req: AuthedRequest<{ orderId: string }>, res: Response, next: NextFunction) {
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, req.params.orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });
  next();
}
