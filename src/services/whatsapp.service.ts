import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createOrGetShareLink } from "@/services/share-link.service";

// Avisos automáticos no WhatsApp pela Evolution API (mesma base da Gira Kids). Sem tela de
// configuração: tudo vem das variáveis de ambiente (Render). Só a conexão do número (QR
// code) fica na aba Usuários, para o admin.
//
//   EVOLUTION_API_URL         https://evolution.exemplo.com
//   EVOLUTION_API_KEY         chave global da Evolution
//   EVOLUTION_INSTANCE        nome da instância (padrão "box")
//   WHATSAPP_NOTIFY_NUMBERS   equipe avisada ao finalizar: "Tania:5511999999999,Luiz:5511988888888"
//   WHATSAPP_NOTIFY_CLIENT    "false" desliga o aviso ao dono do veículo
//   WHATSAPP_INTERVAL_SECONDS pausa entre mensagens (padrão 15, mínimo 8)
//   FRONTEND_URL              base do link de acompanhamento (/acompanhar/<token>)
//   PUBLIC_API_URL            URL pública do backend (webhook das respostas SAIR/VOLTAR)
//
// Os avisos entram numa fila no banco e saem um por vez, com pausa variada. Finalizar o
// projeto nunca depende do WhatsApp: se a Evolution cair, a fila só espera.

const DEFAULT_INTERVAL = 15;
const MIN_INTERVAL = 8;
const MAX_ATTEMPTS = 3;
// Aviso preso na fila além disso não sai mais (chegaria fora de hora).
const VALID_HOURS = 12;

const OPT_OUT_WORDS = [
  "SAIR",
  "PARAR",
  "STOP",
  "CANCELAR",
  "DESCADASTRAR",
  "NAO QUERO",
  "NAO QUERO MAIS",
  "NAO QUERO RECEBER",
  "NAO QUERO MAIS RECEBER",
  "NAO QUERO MAIS RECEBER AVISOS",
  "NAO ENVIE MAIS",
  "NAO MANDE MAIS",
];
const OPT_IN_WORDS = ["VOLTAR", "ATIVAR", "QUERO RECEBER", "RECEBER AVISOS"];

export const FOOTER = "_Mensagem automática. Para não receber mais estes avisos, responda SAIR._";

export class WhatsappError extends Error {
  httpStatus?: number;
  noWhatsapp?: boolean;
  constructor(message: string, public status: number) {
    super(message);
  }
}

let processing = false;
let timer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Configuração (variáveis de ambiente)
// ---------------------------------------------------------------------------

interface Config {
  url: string | null;
  apiKey: string | null;
  instance: string;
}

function readConfig(): Config {
  return {
    url: (process.env.EVOLUTION_API_URL || "").trim().replace(/\/+$/, "") || null,
    apiKey: (process.env.EVOLUTION_API_KEY || "").trim() || null,
    instance: (process.env.EVOLUTION_INSTANCE || "").trim() || "box",
  };
}

function isConfigured(config = readConfig()) {
  return Boolean(config.url && config.apiKey);
}

function intervalMs() {
  const seconds = Number(process.env.WHATSAPP_INTERVAL_SECONDS) || DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, seconds) * 1000;
}

function notifyClient() {
  return process.env.WHATSAPP_NOTIFY_CLIENT !== "false";
}

/** "Tania:5511999999999,Luiz:11988888888" (nome opcional) → [{ name, phone }]. */
export function parseNotifyNumbers(value = process.env.WHATSAPP_NOTIFY_NUMBERS) {
  return String(value || "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [first, second] = item.includes(":") ? item.split(":") : ["", item];
      return { name: first.trim() || null, phone: normalizePhone(second) };
    })
    .filter((item): item is { name: string | null; phone: string } => Boolean(item.phone));
}

// ---------------------------------------------------------------------------
// Telefone
// ---------------------------------------------------------------------------

/** 55 + DDD + número; null se não der para usar. */
export function normalizePhone(phone?: string | null) {
  let digits = String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return /^55\d{10,11}$/.test(digits) ? digits : null;
}

/** Mesma chave com ou sem o 9º dígito do celular (55 + DDD + 8 últimos). */
export function phoneKey(phone?: string | null) {
  const number = normalizePhone(phone);
  return number ? `${number.slice(0, 4)}${number.slice(-8)}` : null;
}

// ---------------------------------------------------------------------------
// Evolution API
// ---------------------------------------------------------------------------

async function evolution(config: Config, path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
  if (!config.url || !config.apiKey) throw new WhatsappError("WhatsApp não configurado (EVOLUTION_API_URL e EVOLUTION_API_KEY).", 400);
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers: { apikey: config.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new WhatsappError(`Não foi possível falar com a Evolution API: ${(err as Error).message}`, 502);
  }
  const raw = await response.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { message: raw };
  }
  if (!response.ok) {
    const message = data?.response?.message ?? data?.message ?? data?.error ?? response.statusText;
    const detail = Array.isArray(message) ? message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ") : String(message);
    const noWhatsapp = /"exists":\s*false/.test(detail);
    const error = new WhatsappError(
      response.status === 401 || response.status === 403
        ? "A Evolution API recusou a chave (apikey). Confira EVOLUTION_API_KEY."
        : noWhatsapp
          ? "Este número não tem WhatsApp."
          : `Evolution API respondeu ${response.status}: ${detail}`,
      response.status === 404 ? 404 : 502
    );
    error.httpStatus = response.status;
    error.noWhatsapp = noWhatsapp;
    throw error;
  }
  return data;
}

async function connectionState(config: Config): Promise<string> {
  const r = await evolution(config, `/instance/connectionState/${encodeURIComponent(config.instance)}`);
  return r?.instance?.state || r?.state || "unknown";
}

/** Estado do número enviador (aba Usuários). */
export async function getConnection() {
  const config = readConfig();
  if (!isConfigured(config)) return { configured: false, state: null as string | null, number: null as string | null };
  try {
    const state = await connectionState(config);
    let number: string | null = null;
    if (state === "open") {
      const instances = await evolution(config, `/instance/fetchInstances?instanceName=${encodeURIComponent(config.instance)}`).catch(() => null);
      const item = Array.isArray(instances) ? instances[0] : instances;
      const owner = item?.ownerJid || item?.instance?.owner || item?.owner;
      number = owner ? String(owner).split("@")[0] : null;
    }
    return { configured: true, state, number };
  } catch (err) {
    // Instância ainda não criada não é erro: ela é criada ao conectar.
    if ((err as WhatsappError).httpStatus === 404) return { configured: true, state: "missing", number: null };
    return { configured: true, state: "error", number: null, error: (err as Error).message };
  }
}

// Token secreto da URL do webhook, derivado da chave (não precisa guardar nada).
export function webhookToken(config = readConfig()) {
  if (!config.apiKey) return null;
  return crypto.createHmac("sha256", config.apiKey).update(`whatsapp-webhook:${config.instance}`).digest("hex").slice(0, 40);
}

export function isValidWebhookToken(token: string) {
  const expected = webhookToken();
  if (!expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// Webhook que recebe as respostas (para o SAIR/VOLTAR). Sem ele só o SAIR não funciona.
async function setWebhook(config: Config, baseUrl: string) {
  try {
    await evolution(config, `/webhook/set/${encodeURIComponent(config.instance)}`, {
      method: "POST",
      body: {
        webhook: {
          enabled: true,
          // Aceita a base com ou sem "/api" no fim.
          url: `${baseUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/whatsapp/webhook/${webhookToken(config)}`,
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT"],
        },
      },
    });
  } catch (err) {
    console.error("[whatsapp] webhook:", (err as Error).message);
  }
}

/** QR code para conectar o número; cria a instância se precisar e liga o webhook das respostas. */
export async function connect(baseUrl: string) {
  const config = readConfig();
  if (!isConfigured(config)) throw new WhatsappError("Configure EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor antes de conectar.", 400);
  const state = await connectionState(config).catch((err: WhatsappError) => {
    if (err.httpStatus === 404) return "missing";
    throw err;
  });

  let r: any = null;
  if (state === "missing") {
    r = await evolution(config, "/instance/create", {
      method: "POST",
      body: { instanceName: config.instance, integration: "WHATSAPP-BAILEYS", qrcode: true },
    });
    r = r?.qrcode || r;
  }
  await setWebhook(config, baseUrl);
  if (state === "open") return { state, qrBase64: null, pairingCode: null };
  if (!r) r = await evolution(config, `/instance/connect/${encodeURIComponent(config.instance)}`);

  const base64: string | null = r?.base64 || null;
  return {
    state: "connecting",
    qrBase64: base64 && !base64.startsWith("data:") ? `data:image/png;base64,${base64}` : base64,
    pairingCode: r?.pairingCode || null,
  };
}

/** Desconecta o número (para trocar por outro). */
export async function disconnect() {
  const config = readConfig();
  if (!isConfigured(config)) throw new WhatsappError("WhatsApp não configurado no servidor.", 400);
  await evolution(config, `/instance/logout/${encodeURIComponent(config.instance)}`, { method: "DELETE" });
  return { state: "close" };
}

// Confere se o número tem WhatsApp e devolve o número exato que o WhatsApp usa (com ou
// sem o 9º dígito). null = não tem WhatsApp. Se a consulta falhar, envia como está.
async function whatsappNumber(config: Config, number: string) {
  try {
    const r = await evolution(config, `/chat/whatsappNumbers/${encodeURIComponent(config.instance)}`, {
      method: "POST",
      body: { numbers: [number] },
    });
    const item = Array.isArray(r) ? r[0] : null;
    if (!item) return number;
    if (item.exists === false) return null;
    return String(item.jid || item.number || number).split("@")[0] || number;
  } catch (err) {
    if ((err as WhatsappError).noWhatsapp) return null;
    return number;
  }
}

function sendText(config: Config, number: string, text: string) {
  return evolution(config, `/message/sendText/${encodeURIComponent(config.instance)}`, {
    method: "POST",
    body: { number, text, delay: 1200 },
  });
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

function firstName(name?: string | null) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "";
}

export interface ReadyOrderInfo {
  code: string;
  ssNumber?: string | null;
  vehicle: { brand: string; model: string; plate?: string | null };
}

function vehicleLabel(order: ReadyOrderInfo) {
  const name = [order.vehicle.brand, order.vehicle.model].filter(Boolean).join(" ").trim();
  return order.vehicle.plate ? `${name} (${order.vehicle.plate})` : name;
}

export function teamMessage(order: ReadyOrderInfo, recipientName: string | null, link: string) {
  const greeting = recipientName ? `Olá, ${firstName(recipientName)}! 🔧` : "Olá! 🔧";
  const project = order.ssNumber ? `${order.code} · SS ${order.ssNumber}` : order.code;
  return `${greeting}\n\nO serviço do veículo *${vehicleLabel(order)}* está pronto.\nProjeto: ${project}\n\nVeja o projeto completo: ${link}\n\n${FOOTER}`;
}

export function clientMessage(order: ReadyOrderInfo, clientName: string | null, link: string) {
  const name = firstName(clientName);
  const greeting = name ? `Olá, ${name}! 😊` : "Olá! 😊";
  return (
    `${greeting}\n\nTemos uma ótima notícia: o seu *${vehicleLabel(order)}* está pronto e já pode ser retirado! 🚗✨\n\n` +
    `Você pode ver tudo o que foi feito por aqui: ${link}\n\nMuito obrigado pela confiança. Estamos te esperando!\n\n${FOOTER}`
  );
}

function shareUrl(token: string) {
  const base = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/acompanhar/${token}`;
}

/**
 * Projeto finalizado: avisa a equipe (WHATSAPP_NOTIFY_NUMBERS) e o dono do veículo, com
 * o link de acompanhamento do projeto. Nunca lança erro — o WhatsApp não pode atrapalhar
 * a finalização. Um aviso por projeto e número (finalizar de novo não repete).
 */
export async function notifyOrderReady(serviceOrderId: string, actorId: string) {
  try {
    if (!isConfigured()) return;
    const order = await prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      include: { vehicle: { include: { owner: { select: { name: true, phone: true } } } } },
    });
    if (!order) return;

    const recipients: { kind: "TEAM" | "CLIENT"; name: string | null; phone: string }[] = parseNotifyNumbers().map((r) => ({ kind: "TEAM", ...r }));
    const ownerPhone = normalizePhone(order.vehicle.owner?.phone);
    if (notifyClient() && ownerPhone) recipients.push({ kind: "CLIENT", name: order.vehicle.owner?.name ?? null, phone: ownerPhone });
    if (!recipients.length) return;

    const link = shareUrl((await createOrGetShareLink(order.id, actorId)).token);
    let queued = false;
    for (const recipient of recipients) {
      const key = phoneKey(recipient.phone)!;
      if (await prisma.whatsappOptOut.findUnique({ where: { phoneKey: key } })) continue;
      const text = recipient.kind === "TEAM" ? teamMessage(order, recipient.name, link) : clientMessage(order, recipient.name, link);
      const existing = await prisma.whatsappMessage.findUnique({
        where: { serviceOrderId_kind_phoneKey: { serviceOrderId: order.id, kind: recipient.kind, phoneKey: key } },
      });
      if (existing) continue;
      await prisma.whatsappMessage.create({
        data: { serviceOrderId: order.id, kind: recipient.kind, recipientName: recipient.name, phone: recipient.phone, phoneKey: key, text },
      });
      queued = true;
    }
    if (queued) schedule(1000);
  } catch (err) {
    console.error("[whatsapp] aviso de projeto finalizado:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Opt-out (SAIR / VOLTAR)
// ---------------------------------------------------------------------------

async function optOut(phone: string) {
  const key = phoneKey(phone);
  if (!key) return;
  await prisma.whatsappOptOut.upsert({ where: { phoneKey: key }, create: { phoneKey: key, phone: normalizePhone(phone) }, update: {} });
  // O que ainda estava na fila para esse número não sai mais.
  await prisma.whatsappMessage.updateMany({ where: { phoneKey: key, status: "QUEUED" }, data: { status: "DISCARDED", error: "Pediu para não receber avisos." } });
}

async function optIn(phone: string) {
  const key = phoneKey(phone);
  if (!key) return;
  await prisma.whatsappOptOut.deleteMany({ where: { phoneKey: key } });
}

export function normalizeReply(text: string) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Número de quem respondeu. Em contas novas o WhatsApp manda um "@lid" no lugar do
// número; aí o número real vem em remoteJidAlt/senderPn.
export function senderPhone(data: any) {
  const candidates = [data?.key?.remoteJid, data?.key?.remoteJidAlt, data?.key?.senderPn, data?.senderPn, data?.key?.participant];
  for (const jid of candidates) {
    const text = String(jid || "");
    if (!text || text.endsWith("@g.us") || text.endsWith("@lid") || text.endsWith("@broadcast")) continue;
    const number = normalizePhone(text.split("@")[0].split(":")[0]);
    if (number) return number;
  }
  return null;
}

/** Resposta recebida. Só vale para quem já recebeu um aviso nosso (conversa normal no mesmo número não dispara nada). */
export async function handleWebhook(body: any) {
  const list = Array.isArray(body?.data) ? body.data : [body?.data];
  const config = readConfig();
  for (const data of list) {
    if (!data || data.key?.fromMe) continue;
    const text = normalizeReply(
      data.message?.conversation ?? data.message?.extendedTextMessage?.text ?? data.message?.buttonsResponseMessage?.selectedDisplayText ?? ""
    );
    const leaving = OPT_OUT_WORDS.includes(text);
    const returning = OPT_IN_WORDS.includes(text);
    if (!leaving && !returning) continue;
    const phone = senderPhone(data);
    const key = phoneKey(phone);
    if (!phone || !key) continue;
    const received = await prisma.whatsappMessage.findFirst({ where: { phoneKey: key, status: "SENT" }, select: { id: true } });
    if (!received) continue;

    if (leaving) {
      await optOut(phone);
      sendText(config, phone, "Pronto! Você não vai mais receber estes avisos automáticos. Se mudar de ideia, é só responder VOLTAR.").catch((err) =>
        console.error("[whatsapp] confirmação SAIR:", err.message)
      );
    } else {
      await optIn(phone);
      sendText(config, phone, "Combinado! Você volta a receber por aqui os avisos automáticos.").catch((err) =>
        console.error("[whatsapp] confirmação VOLTAR:", err.message)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

/** Um envio por vez; se o número estiver desconectado, espera 1 minuto. */
export async function processQueue() {
  if (processing) return;
  processing = true;
  timer = null;
  let nextIn: number | null = null;
  try {
    const config = readConfig();
    if (!isConfigured(config)) return;
    const message = await prisma.whatsappMessage.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    if (!message) return;
    if (Date.now() - message.createdAt.getTime() > VALID_HOURS * 60 * 60 * 1000) {
      await prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: "DISCARDED", error: `Ficou mais de ${VALID_HOURS}h na fila (não enviado atrasado).` } });
      nextIn = 500;
      return;
    }

    const state = await connectionState(config).catch((err: Error) => err.message);
    if (state !== "open") {
      nextIn = 60 * 1000;
      return;
    }

    // Reserva (só se ainda estiver na fila).
    const reserved = await prisma.whatsappMessage.updateMany({
      where: { id: message.id, status: "QUEUED" },
      data: { status: "SENDING", attempts: message.attempts + 1 },
    });
    if (!reserved.count) {
      nextIn = 500;
      return;
    }

    try {
      if (await prisma.whatsappOptOut.findUnique({ where: { phoneKey: message.phoneKey } })) {
        await prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: "DISCARDED", error: "Pediu para não receber avisos." } });
        nextIn = 500;
        return;
      }
      const target = await whatsappNumber(config, message.phone);
      if (!target) {
        await prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: "ERROR", error: "Este número não tem WhatsApp." } });
      } else {
        await sendText(config, target, message.text);
        await prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: "SENT", sentAt: new Date(), error: null, phone: target } });
      }
    } catch (err) {
      const attempts = message.attempts + 1;
      const retry = !(err as WhatsappError).noWhatsapp && attempts < MAX_ATTEMPTS;
      await prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: retry ? "QUEUED" : "ERROR", error: String((err as Error).message).slice(0, 500) } });
      console.error(`[whatsapp] aviso ${message.id}:`, (err as Error).message);
    }
    // Pausa variada (±30%) para não parecer disparo automático.
    nextIn = Math.round(intervalMs() * (0.7 + Math.random() * 0.6));
  } catch (err) {
    console.error("[whatsapp] fila:", (err as Error).message);
    nextIn = 60 * 1000;
  } finally {
    processing = false;
    if (nextIn !== null) schedule(nextIn);
  }
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    processQueue().catch((err) => console.error("[whatsapp] fila:", err.message));
  }, ms);
  timer.unref?.();
}

/** Ao subir o servidor: o que ficou "enviando" volta para a fila. */
export async function startWhatsappQueue() {
  if (!isConfigured()) return;
  try {
    await prisma.whatsappMessage.updateMany({ where: { status: "SENDING" }, data: { status: "QUEUED" } });
  } catch (err) {
    console.error("[whatsapp] iniciar:", (err as Error).message);
    return;
  }
  schedule(15 * 1000);
}
