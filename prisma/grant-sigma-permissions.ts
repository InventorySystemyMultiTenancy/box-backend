// Script pontual e idempotente: cria as novas permissões do gap SIGMA (insurance,
// sectors, services-catalog) e concede ao cargo Administrador, SEM rodar o seed.ts
// completo (que reseta todo o banco). Seguro rodar mais de uma vez.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  { resource: "insurance", action: "view" },
  { resource: "insurance", action: "manage" },
  { resource: "sectors", action: "manage" },
  { resource: "services-catalog", action: "view" },
  { resource: "services-catalog", action: "manage" },
];

async function main() {
  const adminRole = await prisma.role.findUnique({ where: { slug: "admin" } });
  if (!adminRole) {
    console.log("Cargo 'admin' não encontrado — nada a fazer (banco provavelmente não foi seedado ainda).");
    return;
  }

  for (const p of NEW_PERMISSIONS) {
    const permission = await prisma.permission.upsert({
      where: { resource_action: { resource: p.resource, action: p.action } },
      update: {},
      create: p,
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: permission.id },
    });
    console.log(`OK: ${p.resource}.${p.action} concedida ao Administrador`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
