import "dotenv/config";
import { createServer } from "http";
import { app } from "@/app";
import { initSockets } from "@/sockets";
import { startScheduler } from "@/jobs/scheduler";
import { mailProvider } from "@/services/mailer.service";

const PORT = Number(process.env.PORT) || 4000;

const httpServer = createServer(app);
initSockets(httpServer);

httpServer.listen(PORT, () => {
  console.log(`BOX. backend rodando em http://localhost:${PORT}`);
  const mail = mailProvider();
  console.log(mail ? `E-mail: envio via ${mail}` : "E-mail: NÃO configurado (RESEND_API_KEY, BREVO_API_KEY ou SMTP_HOST) — links de senha só no log");
  startScheduler();
});
