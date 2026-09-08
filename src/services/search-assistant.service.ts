// Mesmo provider/modelo já usado em truck-vision.service.ts, vehicle-recognition.service.ts
// e invoice-ocr.service.ts — reaproveitado por consistência (só que aqui só texto, sem imagem).
const OPENAI_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

export class SearchAssistantError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SearchAssistAction {
  path: string;
  label: string;
}

export interface SearchAssistResult {
  message: string;
  steps: string[] | null;
  suggestedQuery: string | null;
  actions: SearchAssistAction[];
}

// Rotas que a IA pode sugerir — mesma lista de abas do painel (src/app/dashboard/layout.tsx
// no front). Qualquer path que a IA responda fora desta lista é descartado antes de
// devolver ao cliente, pra nunca navegar o usuário para algo inexistente/inválido.
const KNOWN_ROUTES: SearchAssistAction[] = [
  { path: "/dashboard", label: "Projetos" },
  { path: "/dashboard/solicitacoes", label: "Solicitações" },
  { path: "/dashboard/usuarios", label: "Usuários" },
  { path: "/dashboard/pecas", label: "Peças" },
  { path: "/dashboard/financeiro", label: "Financeiro" },
  { path: "/dashboard/clientes", label: "Clientes" },
  { path: "/dashboard/complementos", label: "Complementos" },
  { path: "/dashboard/alertas", label: "Alertas" },
  { path: "/dashboard/caminhoes", label: "Caminhões" },
  { path: "/dashboard/seguradoras", label: "Seguradoras" },
  { path: "/dashboard/fornecedores", label: "Fornecedores" },
  { path: "/dashboard/compras", label: "Compras" },
  { path: "/dashboard/agenda", label: "Agenda" },
  { path: "/dashboard/pdv", label: "PDV" },
  { path: "/dashboard/garantias", label: "Garantias" },
  { path: "/dashboard/relatorios", label: "Relatórios" },
  { path: "/dashboard/comissoes", label: "Comissões" },
  { path: "/dashboard/lojas", label: "Lojas" },
  { path: "/dashboard/cargos", label: "Cargos" },
  { path: "/dashboard/perfil", label: "Perfil" },
];

const SYSTEM_PROMPT = `Você é o assistente da BOX., um sistema de gestão de oficina mecânica. Um funcionário digitou algo na busca global do sistema e ela não encontrou nenhum registro (a busca de registros cobre: ordens de serviço, orçamentos, usuários/clientes, veículos, fornecedores, peças de estoque, caminhões e seguradoras).

Isso pode significar duas coisas:
(A) A pessoa estava procurando um registro (cliente, OS, placa, peça...) mas digitou errado ou ele não existe.
(B) A pessoa não está procurando um registro — está PERGUNTANDO como fazer algo no sistema, ex: "como cadastrar um cliente", "como marcar garantia", "como faço um orçamento", "como funciona o pdv". Nesse caso é uma pergunta de uso, não uma busca.

Se for o caso (B), gere um tutorial curto (3 a 5 passos, objetivos, na ordem em que a pessoa deve clicar/preencher) de como realizar aquilo na aba certa do sistema, e aponte essa aba em "actions". Se for o caso (A), não gere tutorial — só explique/sugira como no comportamento normal.

Responda SEMPRE em português, APENAS com um JSON válido, sem markdown, no formato:
{
  "message": "<1-2 frases curtas: no caso B, uma introdução ao tutorial; no caso A, por que talvez não achou nada>",
  "steps": ["<passo 1>", "<passo 2>", "..."] ou null se não for uma pergunta de uso (caso A),
  "suggestedQuery": "<no caso A, um termo de busca alternativo mais provável de achar algo; null no caso B ou se não houver sugestão melhor>",
  "actions": [{ "path": "<uma das rotas da lista abaixo>", "label": "<label EXATAMENTE como está na lista>" }]
}

"actions" deve ter no máximo 2 itens, só rotas realmente relevantes — nunca invente uma rota fora da lista. Se nada for claramente relevante, devolva "actions": [].

Rotas disponíveis (path — label — o que tem lá):
- /dashboard — Projetos — kanban das ordens de serviço em andamento
- /dashboard/solicitacoes — Solicitações — pedidos de orçamento feitos por clientes, aguardando aceite
- /dashboard/usuarios — Usuários — cadastro de usuários do sistema (clientes, mecânicos, admins)
- /dashboard/clientes — Clientes — cadastro de clientes e veículos deles
- /dashboard/pecas — Peças — estoque de peças e materiais, compras
- /dashboard/fornecedores — Fornecedores — cadastro de fornecedores de peças
- /dashboard/compras — Compras — pedidos de compra a fornecedores
- /dashboard/financeiro — Financeiro — contas a pagar/receber, fluxo de caixa, faturas
- /dashboard/comissoes — Comissões — comissão dos mecânicos sobre reparos
- /dashboard/caminhoes — Caminhões — frota, pilotagens e abastecimentos
- /dashboard/seguradoras — Seguradoras — cadastro de seguradoras parceiras
- /dashboard/agenda — Agenda — agendamentos de horário/baia
- /dashboard/pdv — PDV — venda de balcão (peças direto, sem OS)
- /dashboard/garantias — Garantias — peças com garantia vencendo ou vencida
- /dashboard/relatorios — Relatórios — indicadores e relatórios gerenciais
- /dashboard/lojas — Lojas — unidades/lojas cadastradas
- /dashboard/cargos — Cargos — cargos e permissões de acesso
- /dashboard/complementos — Complementos — pendências/complementos de orçamento
- /dashboard/alertas — Alertas — notificações do sistema
- /dashboard/perfil — Perfil — dados da própria conta

Seja direto e útil, como alguém que conhece bem o sistema orientando um colega.`;

export async function getSearchAssistance(query: string): Promise<SearchAssistResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SearchAssistantError("Assistente de IA não configurado (defina OPENAI_API_KEY no ambiente).", 501);
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Texto digitado na busca, sem resultados: "${query}"` },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new SearchAssistantError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new SearchAssistantError("A IA não retornou uma resposta legível.", 502);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SearchAssistantError("A IA retornou um formato inesperado.", 502);
  }

  const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : "Não encontramos nada para esse termo.";
  const suggestedQueryRaw = typeof parsed.suggestedQuery === "string" ? parsed.suggestedQuery.trim() : "";
  const suggestedQuery = suggestedQueryRaw && suggestedQueryRaw.toLowerCase() !== query.trim().toLowerCase() ? suggestedQueryRaw : null;

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 6);

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: SearchAssistAction[] = [];
  for (const item of rawActions) {
    if (!item || typeof item !== "object") continue;
    const path = (item as Record<string, unknown>).path;
    const known = KNOWN_ROUTES.find((r) => r.path === path);
    if (known && !actions.some((a) => a.path === known.path)) actions.push(known);
    if (actions.length >= 2) break;
  }

  return { message, steps: steps.length > 0 ? steps : null, suggestedQuery, actions };
}
