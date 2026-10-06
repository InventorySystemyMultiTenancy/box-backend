import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http-error";
import { sendMail } from "@/services/mailer.service";

const RESET_TTL_MINUTES = 60;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Gera um link de redefinição e manda por e-mail. Responde igual exista ou não o e-mail
 * (quem chama não deve revelar se a conta existe). Só o hash do token fica no banco.
 */
export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) return;

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.$transaction([
    // Um pedido novo invalida links anteriores ainda não usados.
    prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000) },
    }),
  ]);

  const baseUrl = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
  const link = `${baseUrl}/redefinir-senha?token=${token}`;
  await sendMail({
    to: user.email,
    subject: "Redefinição de senha — Reblind",
    text: `Olá, ${user.name}.\n\nRecebemos um pedido para redefinir sua senha. Abra o link abaixo (válido por ${RESET_TTL_MINUTES} minutos):\n\n${link}\n\nSe não foi você, ignore este e-mail — sua senha continua a mesma.`,
    html: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Recebemos um pedido para redefinir sua senha. O link é válido por ${RESET_TTL_MINUTES} minutos:</p><p><a href="${link}">Redefinir minha senha</a></p><p>Se não foi você, ignore este e-mail — sua senha continua a mesma.</p>`,
  });
}

export async function resetPassword(token: string, newPassword: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.active) {
    throw new HttpError(400, "Link inválido ou expirado. Peça um novo em \"Esqueci minha senha\".");
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
