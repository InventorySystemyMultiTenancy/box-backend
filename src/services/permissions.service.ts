import { prisma } from "@/lib/prisma";

export interface PermissionKey {
  resource: string;
  action: string;
}

function key(p: PermissionKey) {
  return `${p.resource}.${p.action}`;
}

// Permissões efetivas de um usuário = permissões do cargo (Role), com exceções
// individuais (UserPermission) por cima: granted=true adiciona, granted=false remove.
// Usuários CUSTOMER não têm cargo e portanto não têm permissões desse sistema.
export async function getEffectivePermissions(userId: string): Promise<Set<string>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roleRef: { include: { rolePermissions: { include: { permission: true } } } },
      userPermissions: { include: { permission: true } },
    },
  });
  if (!user) return new Set();

  const effective = new Set<string>();
  for (const rp of user.roleRef?.rolePermissions ?? []) {
    effective.add(key(rp.permission));
  }
  for (const up of user.userPermissions) {
    const k = key(up.permission);
    if (up.granted) effective.add(k);
    else effective.delete(k);
  }
  return effective;
}

export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const effective = await getEffectivePermissions(userId);
  return effective.has(key({ resource, action }));
}

export async function listPermissionCatalog() {
  return prisma.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }] });
}
