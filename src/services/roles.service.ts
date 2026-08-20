import { prisma } from "@/lib/prisma";

export class RoleError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function listRoles() {
  return prisma.role.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { users: true } } },
  });
}

export async function createRole(data: { name: string; slug: string; description?: string }) {
  const existing = await prisma.role.findUnique({ where: { slug: data.slug } });
  if (existing) throw new RoleError("Já existe um cargo com este identificador.", 409);
  return prisma.role.create({ data });
}

export async function updateRole(id: string, data: { name?: string; description?: string }) {
  return prisma.role.update({ where: { id }, data });
}

export async function deleteRole(id: string) {
  const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
  if (!role) throw new RoleError("Cargo não encontrado.", 404);
  if (role.isSystem) throw new RoleError("Este cargo é protegido pelo sistema e não pode ser excluído.", 400);
  if (role._count.users > 0) throw new RoleError("Não é possível excluir um cargo com funcionários vinculados.", 400);
  await prisma.role.delete({ where: { id } });
}

export async function getRolePermissions(roleId: string) {
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { roleId },
    include: { permission: true },
  });
  return rolePermissions.map((rp) => rp.permission);
}

export async function setRolePermissions(roleId: string, permissionIds: string[]) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new RoleError("Cargo não encontrado.", 404);

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    }),
  ]);
  return getRolePermissions(roleId);
}
