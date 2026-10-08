import nodemailer, { Transporter } from "nodemailer";

// Envio de e-mail, na ordem de preferência:
// 1. RESEND_API_KEY  → API HTTPS do Resend (resend.com);
// 2. BREVO_API_KEY   → API HTTPS do Brevo (brevo.com);
// 3. SMTP_HOST       → SMTP (Gmail com senha de app, Hostinger...).
// As APIs HTTPS funcionam em qualquer hospedagem; o plano gratuito do Render bloqueia as
// portas de SMTP (25/465/587), então lá o SMTP não sai. Sem nada configurado, o conteúdo
// só vai pro log do servidor — útil em dev.
type Provider = "resend" | "brevo" | "smtp" | null;

export function mailProvider(): Provider {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.BREVO_API_KEY) return "brevo";
  if (process.env.SMTP_HOST) return "smtp";
  return null;
}

/** Remetente: MAIL_FROM (ou SMTP_FROM / SMTP_USER), no formato "Nome <email@dominio>". */
function mailFrom() {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || "";
}

function parseAddress(value: string) {
  const match = value.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) return { name: match[1].replace(/^"|"$/g, "") || undefined, email: match[2] };
  return { name: undefined, email: value.trim() };
}

let transporter: Transporter | undefined;
function getTransporter() {
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true", // true só na porta 465
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // Porta bloqueada não pode deixar a requisição pendurada por minutos.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Envio de e-mail recusado (${res.status}): ${detail.slice(0, 500)}`);
  }
}

export async function sendMail({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) {
  const provider = mailProvider();
  if (!provider) {
    console.warn(
      `[e-mail não enviado — configure RESEND_API_KEY, BREVO_API_KEY ou SMTP_HOST] Para: ${to} | Assunto: ${subject}\n${text}`
    );
    return;
  }
  const from = mailFrom();
  if (!from) throw new Error("Remetente não configurado: defina MAIL_FROM (ex.: Reblind <no-reply@seudominio.com.br>).");

  if (provider === "resend") {
    await postJson(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      { from, to: [to], subject, text, html }
    );
  } else if (provider === "brevo") {
    const sender = parseAddress(from);
    await postJson(
      "https://api.brevo.com/v3/smtp/email",
      { "api-key": process.env.BREVO_API_KEY! },
      { sender, to: [{ email: to }], subject, textContent: text, htmlContent: html ?? undefined }
    );
  } else {
    await getTransporter().sendMail({ from, to, subject, text, html });
  }
  console.info(`[e-mail] enviado via ${provider} para ${to} — ${subject}`);
}
