import fs from "fs";
import path from "path";
import multer from "multer";

const UPLOADS_DIR = path.resolve(process.cwd(), process.env.UPLOADS_DIR || "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — suficiente para foto/áudio/vídeo curto de diagnóstico
});

export function guessMediaType(mimetype: string): "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT" {
  if (mimetype.startsWith("image/")) return "PHOTO";
  if (mimetype.startsWith("video/")) return "VIDEO";
  if (mimetype.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

export { UPLOADS_DIR };
