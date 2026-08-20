import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listClients, getClientDetail, createClient, updateClient, archiveClient, ClientError } from "@/services/clients.service";

export const clientsRouter = Router();

const clientSchema = z.object({
  name: z.string().min(2),
  cpfCnpj: z.string().optional(),
  rg: z.string().optional(),
  birthDate: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  addressLine: z.string().optional(),
  zipCode: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  company: z.string().optional(),
  clientType: z.enum(["INDIVIDUAL", "COMPANY"]).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  userId: z.string().optional(),
});

clientsRouter.get("/", requireAuth, requirePermission("clients", "view"), async (req, res) => {
  const result = await listClients(req.query as Record<string, unknown>);
  res.json(result);
});

clientsRouter.get("/:id", requireAuth, requirePermission("clients", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const client = await getClientDetail(req.params.id);
    res.json({ client });
  } catch (err) {
    if (err instanceof ClientError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

clientsRouter.post("/", requireAuth, requirePermission("clients", "create"), async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const client = await createClient(parsed.data);
    res.status(201).json({ client });
  } catch (err) {
    if (err instanceof ClientError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

clientsRouter.patch("/:id", requireAuth, requirePermission("clients", "edit"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const client = await updateClient(req.params.id, parsed.data);
    res.json({ client });
  } catch (err) {
    if (err instanceof ClientError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

clientsRouter.delete("/:id", requireAuth, requirePermission("clients", "delete"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveClient(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ClientError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
