import { Router } from "express";
import { prisma } from "@/lib/prisma";

// Rota pública (sem requireAuth) — alimenta a seção "Equipe" da landing page,
// que não tem sessão de usuário.
export const teamRouter = Router();

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  MECHANIC: "Mecânico",
};

teamRouter.get("/", async (_req, res) => {
  const members = await prisma.user.findMany({
    where: { role: { in: ["MECHANIC", "ADMIN"] } },
    select: {
      id: true,
      name: true,
      role: true,
      avatarUrl: true,
      roleRef: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    team: members.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.roleRef?.name ?? ROLE_LABELS[member.role] ?? member.role,
      avatarUrl: member.avatarUrl,
    })),
  });
});
