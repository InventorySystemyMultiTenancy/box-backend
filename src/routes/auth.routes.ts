import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/jwt";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { getEffectivePermissions, getAllowedTabs } from "@/services/permissions.service";
import { upload, persistUploadedFile } from "@/middleware/upload";
import rateLimit from "express-rate-limit";
import { requestPasswordReset, resetPassword } from "@/services/password-reset.service";

export const authRouter = Router();

// Contra força bruta: tentativas erradas de login por IP (as que dão certo não contam).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde 15 minutos e tente de novo." },
});

// Cadastro e "esqueci minha senha" disparam escrita/e-mail — limite mais apertado.
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas solicitações. Tente de novo mais tarde." },
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
});

authRouter.post("/register", sensitiveLimiter, async (req, res) => {
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
  roleId: z.string().optional(),
  commissionRate: z.number().min(0).max(1).optional(),
});

authRouter.get("/users", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, roleId: true, phone: true, commissionRate: true, active: true, createdAt: true },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });
  res.json({ users });
});

authRouter.post("/users", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = staffCreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
  }
  const { name, email, password, role, roleId, phone, commissionRate } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Este e-mail já está cadastrado." });

  // O cargo já define o perfil de acesso — evita uma combinação sem sentido (ex.: Perfil
  // Cliente + Cargo "Motorista") caso o campo "role" enviado esteja fora de sincronia.
  let effectiveRole = role;
  if (roleId) {
    const cargo = await prisma.role.findUnique({ where: { id: roleId } });
    if (!cargo) return res.status(400).json({ error: "Cargo não encontrado." });
    effectiveRole = cargo.baseRole as typeof role;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: effectiveRole, roleId, phone, commissionRate },
  });

  res.status(201).json({ user: toPublicUser(user) });
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  role: z.enum(["CUSTOMER", "MECHANIC", "ADMIN"]).optional(),
  roleId: z.string().nullable().optional(),
  password: z.string().min(6).optional(),
  commissionRate: z.number().min(0).max(1).nullable().optional(),
  // Desativar = ex-funcionário perde o acesso na hora (ver requireAuth); o histórico fica.
  active: z.boolean().optional(),
});

authRouter.patch("/users/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
  if (req.params.id === req.user!.id && parsed.data.active === false) {
    return res.status(400).json({ error: "Você não pode desativar a sua própria conta." });
  }

  // Mesma regra da criação: se um cargo está sendo definido, o perfil vem dele, não do
  // que foi enviado em "role" — só quando o cargo é removido (roleId: null) o perfil
  // enviado manualmente é respeitado.
  let effectiveRole = parsed.data.role;
  if (parsed.data.roleId) {
    const cargo = await prisma.role.findUnique({ where: { id: parsed.data.roleId } });
    if (!cargo) return res.status(400).json({ error: "Cargo não encontrado." });
    effectiveRole = cargo.baseRole as typeof effectiveRole;
  }

  const passwordHash = parsed.data.password ? await bcrypt.hash(parsed.data.password, 10) : undefined;
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      role: effectiveRole,
      roleId: parsed.data.roleId,
      commissionRate: parsed.data.commissionRate,
      active: parsed.data.active,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  res.json({ user: toPublicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Informe e-mail e senha." });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "E-mail ou senha incorretos." });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  if (!user.active) return res.status(403).json({ error: "Esta conta foi desativada. Fale com o administrador." });

  const token = signToken({ sub: user.id, role: user.role });
  res.json({ token, user: toPublicUser(user) });
});

// "Esqueci minha senha" — sempre responde OK, exista ou não o e-mail (não revela contas).
authRouter.post("/forgot-password", sensitiveLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Informe um e-mail válido." });
  try {
    await requestPasswordReset(parsed.data.email);
  } catch (err) {
    // Falha de SMTP não pode revelar se a conta existe — registra e responde igual.
    console.error("Falha ao enviar e-mail de redefinição de senha:", err);
  }
  res.json({ ok: true });
});

authRouter.post("/reset-password", sensitiveLimiter, async (req, res) => {
  const parsed = z.object({ token: z.string().min(10), password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres." });
  await resetPassword(parsed.data.token, parsed.data.password);
  res.json({ ok: true });
});

// Usuário logado troca a própria senha (confirma a atual antes).
authRouter.patch("/me/password", requireAuth, loginLimiter, async (req: AuthedRequest, res) => {
  const parsed = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres." });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Senha atual incorreta." });

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  res.json({ user: toPublicUser(user) });
});

authRouter.get("/me/permissions", requireAuth, async (req: AuthedRequest, res) => {
  const effective = await getEffectivePermissions(req.user!.id);
  const allowedTabs = await getAllowedTabs(req.user!.id);
  res.json({ permissions: Array.from(effective), allowedTabs });
});

authRouter.patch("/me/avatar", requireAuth, upload.single("avatar"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie uma imagem." });

  const avatarUrl = await persistUploadedFile(req.file);
  const user = await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl } });
  res.json({ user: toPublicUser(user) });
});

function toPublicUser(user: { id: string; name: string; email: string; role: string; roleId?: string | null; phone: string | null; commissionRate?: number | null; avatarUrl?: string | null }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleId: user.roleId ?? null,
    phone: user.phone,
    commissionRate: user.commissionRate ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}
