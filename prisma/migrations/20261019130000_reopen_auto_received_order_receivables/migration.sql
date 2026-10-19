-- Contas a receber de projeto que nasceram já "recebidas" na entrega (opção antiga "cliente
-- já pagou agora", removida) voltam para PENDENTE — o recebimento passa a ser marcado de
-- verdade em Financeiro > Contas a receber. Só as recebidas automaticamente na criação
-- (receivedAt até 1 minuto depois de createdAt); as marcadas como recebidas depois, pelo
-- Financeiro, ficam como estão. A data/valor que estavam ficam anotados na observação.
UPDATE "AccountReceivable"
SET
  "notes" = COALESCE(NULLIF("notes", '') || ' | ', '')
    || 'Estava como recebida automaticamente na entrega em ' || TO_CHAR(("receivedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY')
    || ' (R$ ' || TRIM(TO_CHAR(COALESCE("receivedAmount", "amount"), 'FM999999990.00')) || ') — voltou para pendente em 19/10/2026.',
  "status" = 'PENDING',
  "receivedAt" = NULL,
  "receivedAmount" = NULL
WHERE "serviceOrderId" IS NOT NULL
  AND "status" = 'RECEIVED'
  AND "receivedAt" IS NOT NULL
  AND "receivedAt" <= "createdAt" + INTERVAL '1 minute';
