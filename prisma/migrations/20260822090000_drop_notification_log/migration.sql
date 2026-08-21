-- Feature de notificações (SMS/WhatsApp) removida — não será usada.

-- DropForeignKey
ALTER TABLE "NotificationLog" DROP CONSTRAINT IF EXISTS "NotificationLog_serviceOrderId_fkey";

-- DropTable
DROP TABLE IF EXISTS "NotificationLog";
