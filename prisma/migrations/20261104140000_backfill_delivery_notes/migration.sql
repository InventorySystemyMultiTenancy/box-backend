-- Projetos entregues antes da observação ir para a timeline: cria o evento da entrega
-- com a observação digitada (deliveryDescription), na data de conclusão do projeto.
INSERT INTO "TimelineEvent" ("id", "serviceOrderId", "title", "description", "note", "occurredAt", "done", "createdAt")
SELECT
  'note_' || md5(so."id" || random()::text),
  so."id",
  'Etapa avançada: Pronto para retirada',
  'Observação: ' || btrim(so."deliveryDescription"),
  btrim(so."deliveryDescription"),
  COALESCE(so."completedAt", so."updatedAt"),
  true,
  COALESCE(so."completedAt", so."updatedAt")
FROM "ServiceOrder" so
WHERE so."deliveryDescription" IS NOT NULL
  AND btrim(so."deliveryDescription") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "TimelineEvent" te WHERE te."serviceOrderId" = so."id" AND te."note" IS NOT NULL
  );
