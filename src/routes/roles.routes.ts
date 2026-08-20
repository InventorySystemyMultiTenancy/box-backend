import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listPermissionCatalog } from "@/services/permissions.service";
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  getRolePermissions,
  setRolePermissions,
  RoleError,
} from "@/services/roles.service";

export const rolesRouter = Router();

// Faixa Unicode "Combining Diacritical Marks" (U+0300–U+036F), construída via
// fromCharCode para evitar caracteres de combinação literais no código-fonte.
const DIACRITICS_RE = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const createRoleSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().optional(),
});

const setPermissionsSchema = z.object({
  permissionIds: z.array(z.string()),
});

rolesRouter.get("/", requireAuth, requirePermission("roles", "view"), async (_req, res) => {
  const roles = await listRoles();
  res.json({ roles });
});

rolesRouter.post("/", requireAuth, requirePermission("roles", "manage"), async (req, res) => {
  const parsed = createRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const role = await createRole({ name: parsed.data.name, slug: slugify(parsed.data.name), description: parsed.data.description });
    res.status(201).json({ role });
  } catch (err) {
    if (err instanceof RoleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

rolesRouter.patch("/:id", requireAuth, requirePermission("roles", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const role = await updateRole(req.params.id, parsed.data);
  res.json({ role });
});

rolesRouter.delete("/:id", requireAuth, requirePermission("roles", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await deleteRole(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof RoleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

rolesRouter.get("/:id/permissions", requireAuth, requirePermission("roles", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  const permissions = await getRolePermissions(req.params.id);
  res.json({ permissions });
});

rolesRouter.put("/:id/permissions", requireAuth, requirePermission("roles", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = setPermissionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const permissions = await setRolePermissions(req.params.id, parsed.data.permissionIds);
    res.json({ permissions });
  } catch (err) {
    if (err instanceof RoleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export const permissionsRouter = Router();

permissionsRouter.get("/", requireAuth, requirePermission("roles", "view"), async (_req, res) => {
  const permissions = await listPermissionCatalog();
  res.json({ permissions });
});
