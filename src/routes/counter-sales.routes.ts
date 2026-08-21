import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listCounterSales, createCounterSale, cancelCounterSale, CounterSaleError } from "@/services/counter-sales.service";

export const counterSalesRouter = Router();

const itemSchema = z.object({
  inventoryPartId: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().min(0),
});

const createSchema = z.object({
  clientId: z.string().optional(),
  customerName: z.string().optional(),
  paymentMethod: z.string().optional(),
  bankAccountId: z.string().optional(),
  storeId: z.string().optional(),
  items: z.array(itemSchema).min(1),
});

counterSalesRouter.get("/", requireAuth, requirePermission("pdv", "view"), async (req, res) => {
  const result = await listCounterSales(req.query as Record<string, unknown>);
  res.json(result);
});

counterSalesRouter.post("/", requireAuth, requirePermission("pdv", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const sale = await createCounterSale(parsed.data);
    res.status(201).json({ sale });
  } catch (err) {
    if (err instanceof CounterSaleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

counterSalesRouter.post("/:id/cancel", requireAuth, requirePermission("pdv", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const sale = await cancelCounterSale(req.params.id);
    res.json({ sale });
  } catch (err) {
    if (err instanceof CounterSaleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
