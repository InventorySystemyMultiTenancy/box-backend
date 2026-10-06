import { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { resolveTokenUser } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { resolveShareLinkOrderId } from "@/services/share-link.service";

let io: SocketServer | undefined;

const STAFF_ROOM = "staff";

export function initSockets(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || "http://localhost:3000" },
  });

  io.on("connection", (socket) => {
    // Cliente entra na "sala" da própria ordem de serviço para receber
    // só os eventos que dizem respeito ao carro dele.
    socket.on("join-order", async ({ orderId, token }: { orderId: string; token: string }) => {
      try {
        const user = await resolveTokenUser(token);
        if (!user) return socket.emit("error", { message: "Conta desativada." });
        const allowed = await canAccessServiceOrder(user.id, user.role, orderId);
        if (!allowed) return socket.emit("error", { message: "Sem acesso a esta ordem de serviço." });
        socket.join(roomFor(orderId));
      } catch {
        socket.emit("error", { message: "Token inválido." });
      }
    });

    // Link público de acompanhamento (sem login) — mesma sala order:<id> de sempre, só
    // que a autorização aqui é o próprio token do link (validado e resolvido pro id da
    // ordem), não um JWT de usuário.
    socket.on("join-order-public", async ({ shareToken }: { shareToken: string }) => {
      try {
        const orderId = await resolveShareLinkOrderId(shareToken);
        socket.join(roomFor(orderId));
      } catch {
        socket.emit("error", { message: "Link inválido ou expirado." });
      }
    });

    // Sala pessoal do usuário — usada para notificar sobre a solicitação de
    // orçamento antes de existir uma ordem de serviço (e, portanto, uma sala order:<id>).
    socket.on("join-user", async ({ token }: { token: string }) => {
      try {
        const user = await resolveTokenUser(token);
        if (!user) return socket.emit("error", { message: "Conta desativada." });
        socket.join(userRoomFor(user.id));
      } catch {
        socket.emit("error", { message: "Token inválido." });
      }
    });

    // Sala da equipe — mecânico/admin entram aqui para ver, em tempo real,
    // novas solicitações de orçamento e atualizações de qualquer ordem em andamento.
    socket.on("join-staff", async ({ token }: { token: string }) => {
      try {
        const user = await resolveTokenUser(token);
        if (!user || (user.role !== "MECHANIC" && user.role !== "ADMIN")) {
          return socket.emit("error", { message: "Sem permissão para esta sala." });
        }
        socket.join(STAFF_ROOM);
      } catch {
        socket.emit("error", { message: "Token inválido." });
      }
    });
  });

  return io;
}

function roomFor(orderId: string) {
  return `order:${orderId}`;
}

function userRoomFor(userId: string) {
  return `user:${userId}`;
}

/** Emite um evento em tempo real para todos conectados à ordem de serviço, e também
 * para a equipe (o painel do mecânico acompanha todas as ordens sem precisar entrar
 * em cada sala individualmente). */
export function emitToOrder(orderId: string, event: string, payload: unknown) {
  io?.to(roomFor(orderId)).to(STAFF_ROOM).emit(event, payload);
}

/** Notifica um usuário específico fora do contexto de uma ordem (ex.: resposta a uma
 * solicitação de orçamento, antes de existir um ServiceOrder). */
export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(userRoomFor(userId)).emit(event, payload);
}

/** Notifica todos os mecânicos/admins conectados (ex.: nova solicitação de orçamento). */
export function emitToStaff(event: string, payload: unknown) {
  io?.to(STAFF_ROOM).emit(event, payload);
}
