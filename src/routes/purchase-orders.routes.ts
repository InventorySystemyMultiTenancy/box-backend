import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listPurchaseOrders,
  getPurchaseOrderDetail,
  createPurchaseOrder,
  sendPurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  listReplenishmentSuggestions,
  createPurchaseOrdersFromSuggestions,
  PurchaseOrderError,
} from "@/services/purchase-orders.service";

export const purchaseOrdersRouter = Router();

const itemSchema = z.object({
  inventoryPartId: z.string(),
  quantity: z.number().int().positive(),
  unitCost: z.number().min(0),
});

const createSchema = z.object({
  supplierId: z.string(),
  storeId: z.string().optional(),
  expectedDate: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1),
});

const receiveSchema = z.object({
  items: z.array(z.object({ itemId: z.string(), receivedQty: z.number().int().positive() })).min(1),
});

purchaseOrdersRouter.get("/", requireAuth, requirePermission("purchases", "view"), async (req, res) => {
  const result = await listPurchaseOrders(req.query as Record<string, unknown>);
  res.json(result);
});

purchaseOrdersRouter.get("/replenishment-suggestions", requireAuth, requirePermission("purchases", "view"), async (_req, res) => {
  const suggestions = await listReplenishmentSuggestions();
  res.json({ suggestions });
});

purchaseOrdersRouter.post("/from-suggestions", requireAuth, requirePermission("purchases", "manage"), async (_req, res) => {
  const result = await createPurchaseOrdersFromSuggestions();
  res.status(201).json(result);
});

purchaseOrdersRouter.get("/:id", requireAuth, requirePermission("purchases", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const order = await getPurchaseOrderDetail(req.params.id);
    res.json({ order });
  } catch (err) {
    if (err instanceof PurchaseOrderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

purchaseOrdersRouter.post("/", requireAuth, requirePermission("purchases", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const order = await createPurchaseOrder(parsed.data);
    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof PurchaseOrderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

purchaseOrdersRouter.post("/:id/send", requireAuth, requirePermission("purchases", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const order = await sendPurchaseOrder(req.params.id);
    res.json({ order });
  } catch (err) {
    if (err instanceof PurchaseOrderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

purchaseOrdersRouter.post("/:id/receive", requireAuth, requirePermission("purchases", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const order = await receivePurchaseOrder(req.params.id, parsed.data.items);
    res.json({ order });
  } catch (err) {
    if (err instanceof PurchaseOrderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

purchaseOrdersRouter.post("/:id/cancel", requireAuth, requirePermission("purchases", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const order = await cancelPurchaseOrder(req.params.id);
    res.json({ order });
  } catch (err) {
    if (err instanceof PurchaseOrderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
