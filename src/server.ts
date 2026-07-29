import "dotenv/config";
import { createServer } from "http";
import { app } from "@/app";
import { initSockets } from "@/sockets";

const PORT = Number(process.env.PORT) || 4000;

const httpServer = createServer(app);
initSockets(httpServer);

httpServer.listen(PORT, () => {
  console.log(`BOX. backend rodando em http://localhost:${PORT}`);
});
