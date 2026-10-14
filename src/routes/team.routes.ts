import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";

// GET / é público (sem requireAuth) — alimenta a seção "Equipe" da landing page,
// que não tem sessão de usuário.
export const teamRouter = Router();

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  MECHANIC: "Mecânico",
};

teamRouter.get("/", async (_req, res) => {
  const members = await prisma.user.findMany({
    where: { role: { in: ["MECHANIC", "ADMIN"] }, active: true },
    select: {
      id: true,
      name: true,
      role: true,
      avatarUrl: true,
      roleRef: { select: { name: true, allowedTabs: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    team: members.filter(signsService).map((member) => ({
      id: member.id,
      name: member.name,
      role: member.roleRef?.name ?? ROLE_LABELS[member.role] ?? member.role,
      avatarUrl: member.avatarUrl,
    })),
  });
});

// Funcionários que o admin pode associar a um projeto — mesmo critério de quem "assina o
// serviço" (tem acesso à aba Projetos). Admin entra na lista, mas já enxerga todos.
teamRouter.get("/assignable", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const members = await prisma.user.findMany({
    where: { role: { in: ["MECHANIC", "ADMIN"] }, active: true },
    select: { id: true, name: true, role: true, roleRef: { select: { name: true, allowedTabs: true } } },
    orderBy: { name: "asc" },
  });
  res.json({
    staff: members.filter(signsService).map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      roleLabel: member.roleRef?.name ?? ROLE_LABELS[member.role] ?? member.role,
    })),
  });
});

function signsService(member: { roleRef: { allowedTabs: string[] } | null }) {
  // Perfil MECHANIC/ADMIN não basta — um cargo como "Motorista" (baseRole MECHANIC,
  // mas allowedTabs restrito só a Caminhões) não deve aparecer como quem "assina o
  // serviço". Só entra quem não tem cargo (mecânico/admin tradicional, sem restrição)
  // ou cujo cargo inclui a aba Projetos — onde de fato se diagnostica/precifica reparo
  // (cobre também um cargo tipo "Orçamentista", desde que enxergue Projetos).
  const allowedTabs = member.roleRef?.allowedTabs ?? [];
  return allowedTabs.length === 0 || allowedTabs.includes("projects");
}
