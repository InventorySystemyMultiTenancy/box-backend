import express from "express";
import cors from "cors";
import path from "path";
import { authRouter } from "@/routes/auth.routes";
import { vehiclesRouter } from "@/routes/vehicles.routes";
import { serviceOrdersRouter } from "@/routes/service-orders.routes";
import { timelineRouter } from "@/routes/timeline.routes";
import { partsRouter } from "@/routes/parts.routes";
import { approvalsRouter } from "@/routes/approvals.routes";
import { chatRouter } from "@/routes/chat.routes";
import { uploadsRouter } from "@/routes/uploads.routes";
import { quoteRequestsRouter } from "@/routes/quote-requests.routes";

export const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json());
app.use("/uploads", express.static(path.resolve(process.cwd(), process.env.UPLOADS_DIR || "uploads")));

app.get("/health", (_req, res) => res.json({ ok: true, service: "box-backend" }));

app.use("/api/auth", authRouter);
app.use("/api/vehicles", vehiclesRouter);
app.use("/api/service-orders", serviceOrdersRouter);
app.use("/api/service-orders/:orderId/timeline", timelineRouter);
app.use("/api/service-orders/:orderId/parts", partsRouter);
app.use("/api/service-orders/:orderId/approvals", approvalsRouter);
app.use("/api/service-orders/:orderId/chat", chatRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/quote-requests", quoteRequestsRouter);

app.use((_req, res) => res.status(404).json({ error: "Rota não encontrada." }));
