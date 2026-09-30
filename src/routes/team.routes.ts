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
      roleRef: { select: { name: true, allowedTabs: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Perfil MECHANIC/ADMIN não basta — um cargo como "Motorista" (baseRole MECHANIC,
  // mas allowedTabs restrito só a Caminhões) não deve aparecer como quem "assina o
  // serviço". Só entra quem não tem cargo (mecânico/admin tradicional, sem restrição)
  // ou cujo cargo inclui a aba Projetos — onde de fato se diagnostica/precifica reparo
  // (cobre também um cargo tipo "Orçamentista", desde que enxergue Projetos).
  const signsService = members.filter((member) => {
    const allowedTabs = member.roleRef?.allowedTabs ?? [];
    return allowedTabs.length === 0 || allowedTabs.includes("projects");
  });

  res.json({
    team: signsService.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.roleRef?.name ?? ROLE_LABELS[member.role] ?? member.role,
      avatarUrl: member.avatarUrl,
    })),
  });
});
