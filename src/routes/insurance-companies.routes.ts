import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listInsuranceCompanies,
  getInsuranceCompanyDetail,
  createInsuranceCompany,
  updateInsuranceCompany,
  archiveInsuranceCompany,
  InsuranceCompanyError,
} from "@/services/insurance-companies.service";

export const insuranceCompaniesRouter = Router();

const insuranceCompanySchema = z.object({
  legalName: z.string().min(2),
  tradeName: z.string().optional(),
  cnpj: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  contactName: z.string().optional(),
  accredited: z.coerce.boolean().optional(),
  notes: z.string().optional(),
});

insuranceCompaniesRouter.get("/", requireAuth, requirePermission("insurance", "view"), async (req, res) => {
  const result = await listInsuranceCompanies(req.query as Record<string, unknown>);
  res.json(result);
});

insuranceCompaniesRouter.get("/:id", requireAuth, requirePermission("insurance", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const company = await getInsuranceCompanyDetail(req.params.id);
    res.json({ company });
  } catch (err) {
    if (err instanceof InsuranceCompanyError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

insuranceCompaniesRouter.post("/", requireAuth, requirePermission("insurance", "manage"), async (req, res) => {
  const parsed = insuranceCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const company = await createInsuranceCompany(parsed.data);
  res.status(201).json({ company });
});

insuranceCompaniesRouter.patch("/:id", requireAuth, requirePermission("insurance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = insuranceCompanySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const company = await updateInsuranceCompany(req.params.id, parsed.data);
    res.json({ company });
  } catch (err) {
    if (err instanceof InsuranceCompanyError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

insuranceCompaniesRouter.delete("/:id", requireAuth, requirePermission("insurance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveInsuranceCompany(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof InsuranceCompanyError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
