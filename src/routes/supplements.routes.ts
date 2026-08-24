import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";
import { SUPPLEMENT_PENDING_ALERT_DAYS } from "@/lib/constants";

export const supplementsRouter = Router();

// Painel "Complementos pendentes" (Fase 2) — Approval com kind=SUPPLEMENT ainda sem
// resposta do cliente, cruzando OS/veículo/seguradora. Reaproveita o mesmo modelo
// Approval já usado para aprovações normais, só filtrado por kind.
supplementsRouter.get("/pending", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const supplements = await prisma.approval.findMany({
    where: { kind: "SUPPLEMENT", status: "PENDING" },
    include: {
      serviceOrder: {
        include: {
          vehicle: { include: { owner: { select: { id: true, name: true } } } },
          insuranceCompany: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const now = Date.now();
  const items = supplements.map((s) => {
    const daysWaiting = Math.floor((now - s.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      justification: s.justification,
      extraHours: s.extraHours,
      estimatedValue: s.estimatedValue,
      createdAt: s.createdAt,
      daysWaiting,
      overdue: daysWaiting >= SUPPLEMENT_PENDING_ALERT_DAYS,
      serviceOrder: {
        id: s.serviceOrder.id,
        code: s.serviceOrder.code,
        status: s.serviceOrder.status,
      },
      vehicle: {
        brand: s.serviceOrder.vehicle.brand,
        model: s.serviceOrder.vehicle.model,
        plate: s.serviceOrder.vehicle.plate,
      },
      owner: s.serviceOrder.vehicle.owner,
      insuranceCompany: s.serviceOrder.insuranceCompany ? { id: s.serviceOrder.insuranceCompany.id, tradeName: s.serviceOrder.insuranceCompany.tradeName ?? s.serviceOrder.insuranceCompany.legalName } : null,
    };
  });

  res.json({ items });
});
