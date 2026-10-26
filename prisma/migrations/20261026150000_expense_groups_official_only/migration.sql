-- "Grupo despesa" sugere só os grupos do plano de contas. Os grupos antigos digitados à mão
-- (DESPESA FIXA, ADMINISTRATIVA, VEICULO/FROTA...) não têm categorias e confundiam a escolha.
-- Só sai a sugestão: as contas e notas já lançadas continuam com o grupo que têm.
DELETE FROM "ExpenseClassification"
WHERE kind = 'GROUP'
  AND name NOT IN (
    'DESPESAS FIXAS', 'DESPESAS ADMINISTRATIVAS', 'DESPESAS MARKETING', 'DESPESAS PREDIAIS',
    'DESPESAS OPERACIONAIS', 'DESPESAS - VEÍCULO/FROTA', 'IMOBILIZADO', 'FOLHA DE PAGAMENTO',
    'IMPOSTOS', 'DESPESAS FINANCEIRAS'
  );
