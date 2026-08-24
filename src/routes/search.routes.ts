import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";

export const searchRouter = Router();

// Busca global por nº de OS, placa, cliente, seguradora, veículo, consultor,
// orçamentista — agrega ServiceOrder/Estimate num único resultado.
searchRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.json({ orders: [], estimates: [] });

  const [orders, estimates] = await Promise.all([
    prisma.serviceOrder.findMany({
      where: {
        OR: [
          { code: { contains: q, mode: "insensitive" } },
          { vehicle: { plate: { contains: q, mode: "insensitive" } } },
          { vehicle: { brand: { contains: q, mode: "insensitive" } } },
          { vehicle: { model: { contains: q, mode: "insensitive" } } },
          { vehicle: { owner: { name: { contains: q, mode: "insensitive" } } } },
          { insuranceCompany: { legalName: { contains: q, mode: "insensitive" } } },
          { insuranceCompany: { tradeName: { contains: q, mode: "insensitive" } } },
          { consultant: { name: { contains: q, mode: "insensitive" } } },
          { estimator: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      include: {
        vehicle: { include: { owner: { select: { id: true, name: true } } } },
        insuranceCompany: true,
        consultant: { select: { id: true, name: true } },
        estimator: { select: { id: true, name: true } },
        currentSector: true,
      },
      take: 25,
      orderBy: { createdAt: "desc" },
    }),
    prisma.estimate.findMany({
      where: { code: { contains: q, mode: "insensitive" } },
      include: { serviceOrder: { include: { vehicle: true } } },
      take: 25,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.json({ orders, estimates });
});
