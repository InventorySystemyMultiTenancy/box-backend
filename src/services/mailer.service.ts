import nodemailer, { Transporter } from "nodemailer";

// SMTP configurável por variáveis de ambiente (Gmail com senha de app, Hostinger, Resend,
// Brevo...). Sem SMTP_HOST, nada é enviado: o conteúdo só vai pro log do servidor — útil
// em dev e pra não travar o fluxo de "esqueci minha senha" antes de configurar o e-mail.
function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

let transporter: Transporter | undefined;
function getTransporter() {
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true", // true só na porta 465
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendMail({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) {
  if (!smtpConfigured()) {
    console.warn(`[e-mail não enviado — SMTP_HOST não configurado] Para: ${to} | Assunto: ${subject}\n${text}`);
    return;
  }
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}
