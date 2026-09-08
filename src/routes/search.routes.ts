import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";

export const searchRouter = Router();

// Busca global — cobre praticamente todo cadastro do sistema (OS, orçamentos,
// usuários/clientes, veículos, fornecedores, peças de estoque, caminhões e
// seguradoras), cada um com "contains" case-insensitive nos campos relevantes.
searchRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const empty = { orders: [], estimates: [], users: [], vehicles: [], suppliers: [], parts: [], trucks: [], insuranceCompanies: [] };
  if (q.length < 2) return res.json(empty);
  const contains = { contains: q, mode: "insensitive" as const };

  const [orders, estimates, users, vehicles, suppliers, parts, trucks, insuranceCompanies] = await Promise.all([
    prisma.serviceOrder.findMany({
      where: {
        OR: [
          { code: contains },
          { vehicle: { plate: contains } },
          { vehicle: { brand: contains } },
          { vehicle: { model: contains } },
          { vehicle: { owner: { name: contains } } },
          { insuranceCompany: { legalName: contains } },
          { insuranceCompany: { tradeName: contains } },
          { consultant: { name: contains } },
          { estimator: { name: contains } },
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
      where: { code: contains },
      include: { serviceOrder: { include: { vehicle: true } } },
      take: 25,
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { OR: [{ name: contains }, { email: contains }, { phone: contains }] },
      select: { id: true, name: true, email: true, phone: true, role: true },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.vehicle.findMany({
      where: {
        OR: [
          { brand: contains },
          { model: contains },
          { plate: contains },
          { chassi: contains },
          { renavam: contains },
          { owner: { name: contains } },
        ],
      },
      include: { owner: { select: { id: true, name: true } } },
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prisma.supplier.findMany({
      where: { OR: [{ name: contains }, { cpfCnpj: contains }, { contactName: contains }, { phone: contains }, { email: contains }] },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.inventoryPart.findMany({
      where: { OR: [{ name: contains }, { sku: contains }, { description: contains }] },
      take: 10,
      orderBy: { name: "asc" },
    }),
    prisma.truck.findMany({
      where: { OR: [{ plate: contains }, { brand: contains }, { model: contains }] },
      take: 10,
      orderBy: { plate: "asc" },
    }),
    prisma.insuranceCompany.findMany({
      where: { OR: [{ legalName: contains }, { tradeName: contains }] },
      take: 10,
      orderBy: { legalName: "asc" },
    }),
  ]);

  res.json({ orders, estimates, users, vehicles, suppliers, parts, trucks, insuranceCompanies });
});
