import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/jwt";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
  }
  const { name, email, password, phone } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Este e-mail já está cadastrado." });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: "CUSTOMER", phone },
  });

  const token = signToken({ sub: user.id, role: user.role });
  res.status(201).json({ token, user: toPublicUser(user) });
});

const staffCreateUserSchema = registerSchema.extend({
  role: z.enum(["CUSTOMER", "MECHANIC", "ADMIN"]),
});

authRouter.get("/users", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, phone: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ users });
});

authRouter.post("/users", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = staffCreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Dados invÃ¡lidos.", details: parsed.error.flatten() });
  }
  const { name, email, password, role, phone } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Este e-mail jÃ¡ estÃ¡ cadastrado." });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role, phone },
  });

  res.status(201).json({ user: toPublicUser(user) });
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  role: z.enum(["CUSTOMER", "MECHANIC", "ADMIN"]).optional(),
  password: z.string().min(6).optional(),
});

authRouter.patch("/users/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const passwordHash = parsed.data.password ? await bcrypt.hash(parsed.data.password, 10) : undefined;
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      role: parsed.data.role,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  res.json({ user: toPublicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Informe e-mail e senha." });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "E-mail ou senha incorretos." });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "E-mail ou senha incorretos." });

  const token = signToken({ sub: user.id, role: user.role });
  res.json({ token, user: toPublicUser(user) });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  res.json({ user: toPublicUser(user) });
});

function toPublicUser(user: { id: string; name: string; email: string; role: string; phone: string | null }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone };
}
