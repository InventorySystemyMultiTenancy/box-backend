-- Sequência dedicada para o código da ordem de serviço (OS-AAAA-NNNNN). Substitui o
-- cálculo antigo baseado em COUNT(*) (ver src/lib/order-code.ts), que colidia com a
-- constraint única de "code" sempre que duas criações aconteciam ao mesmo tempo, ou
-- quando uma ordem era excluída (DELETE /api/service-orders/:id) e a contagem caía,
-- fazendo a próxima ordem reaproveitar um número de sequência já usado por uma ordem
-- que continuava existindo.
CREATE SEQUENCE IF NOT EXISTS "ServiceOrder_code_seq";

-- Alinha o próximo valor da sequência com o maior número já em uso pelo esquema antigo,
-- pra não colidir com nenhum código já existente.
DO $$
DECLARE
  max_seq integer;
BEGIN
  SELECT COALESCE(MAX(CAST(regexp_replace("code", '^OS-\d{4}-', '') AS integer)), 1000)
  INTO max_seq
  FROM "ServiceOrder"
  WHERE "code" ~ '^OS-\d{4}-\d+$';

  PERFORM setval('"ServiceOrder_code_seq"', max_seq);
END $$;
