-- Contas a receber de projeto passam a mostrar a placa na descrição (antes: "Serviços — OS <código>").
-- A OS continua ligada (serviceOrderId), então a busca por OS segue funcionando.
UPDATE "AccountReceivable" AS ar
SET "description" = 'Serviços — ' || COALESCE(NULLIF(TRIM(v."plate"), ''), v."brand" || ' ' || v."model")
FROM "ServiceOrder" AS so
JOIN "Vehicle" AS v ON v."id" = so."vehicleId"
WHERE ar."serviceOrderId" = so."id"
  AND ar."description" = 'Serviços — OS ' || so."code";
