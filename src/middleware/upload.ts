import fs from "fs";
import path from "path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const UPLOADS_DIR = path.resolve(process.cwd(), process.env.UPLOADS_DIR || "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

export class UploadTypeError extends Error {}

// Arquivos enviados ficam públicos em /uploads — só aceita mídia e PDF. SVG fica de fora
// mesmo sendo "image/*" porque pode carregar script; extensões executáveis/HTML são
// recusadas mesmo que o navegador declare um mimetype permitido.
const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];
const ALLOWED_MIME_TYPES = new Set(["application/pdf"]);
const BLOCKED_EXTENSIONS = new Set([".svg", ".svgz", ".html", ".htm", ".xhtml", ".js", ".mjs", ".exe", ".bat", ".cmd", ".sh", ".php", ".msi", ".dll"]);

export function isAllowedUpload(mimetype: string, originalname: string) {
  const ext = path.extname(originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  if (mimetype === "image/svg+xml") return false;
  return ALLOWED_MIME_TYPES.has(mimetype) || ALLOWED_MIME_PREFIXES.some((prefix) => mimetype.startsWith(prefix));
}

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — suficiente para foto/áudio/vídeo curto de diagnóstico
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file.mimetype, file.originalname)) return cb(null, true);
    cb(new UploadTypeError("Tipo de arquivo não permitido. Envie foto, vídeo, áudio ou PDF."));
  },
});

export function guessMediaType(mimetype: string): "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT" {
  if (mimetype.startsWith("image/")) return "PHOTO";
  if (mimetype.startsWith("video/")) return "VIDEO";
  if (mimetype.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

function hasCloudinaryConfig() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

export async function persistUploadedFile(file: Express.Multer.File) {
  if (!hasCloudinaryConfig()) {
    return `/uploads/${file.filename}`;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  const result = await cloudinary.uploader.upload(file.path, {
    folder: process.env.CLOUDINARY_FOLDER || "box-diagnosticos",
    resource_type: "auto",
  });

  fs.promises.unlink(file.path).catch(() => {});
  return result.secure_url;
}

export { UPLOADS_DIR };
