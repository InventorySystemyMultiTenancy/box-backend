import { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { verifyToken } from "@/lib/jwt";
import { canAccessServiceOrder } from "@/lib/authorization";

let io: SocketServer | undefined;

export function initSockets(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || "http://localhost:3000" },
  });

  io.on("connection", (socket) => {
    // Cliente entra na "sala" da própria ordem de serviço para receber
    // só os eventos que dizem respeito ao carro dele.
    socket.on("join-order", async ({ orderId, token }: { orderId: string; token: string }) => {
      try {
        const payload = verifyToken(token);
        const allowed = await canAccessServiceOrder(payload.sub, payload.role, orderId);
        if (!allowed) return socket.emit("error", { message: "Sem acesso a esta ordem de serviço." });
        socket.join(roomFor(orderId));
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

/** Emite um evento em tempo real para todos conectados à ordem de serviço. */
export function emitToOrder(orderId: string, event: string, payload: unknown) {
  io?.to(roomFor(orderId)).emit(event, payload);
}
