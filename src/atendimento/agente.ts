// Motor do Agente Apta: chamado quando chega mensagem numa conversa em modo
// AGENTE. Usa a API do Gemini (Google) com as instruções cadastradas no
// AgenteIA como contexto fixo, mais o histórico recente da conversa. Se o
// Gemini falhar ou a chave não estiver configurada, a conversa volta sozinha
// para o modo HUMANO em vez de ficar "presa" sem resposta.
import type { Cliente } from "@prisma/client";
import { linkPublico } from "../envio/mensagem-protocolo.js";
import { prisma } from "../prisma.js";
import { enviarMensagem, registrarSistema } from "./conversas.js";

// Quantas mensagens recentes (cliente + agente/atendente) entram no contexto
// mandado pro Gemini a cada resposta.
const HISTORICO_MAX = 20;

// Config do banco (tela "Agentes e IA") tem prioridade; GEMINI_API_KEY/
// GEMINI_MODEL no ambiente servem de valor padrão enquanto ninguém configurar
// pela tela.
async function configGemini() {
  const config = await prisma.configuracaoGemini.findUnique({ where: { id: 1 } });
  return {
    apiKey: config?.apiKey || process.env.GEMINI_API_KEY || null,
    modelo: config?.modelo || process.env.GEMINI_MODEL || "gemini-flash-latest",
  };
}

export async function motorAgenteConfigurado(): Promise<boolean> {
  return Boolean((await configGemini()).apiKey);
}

interface ParteGemini {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface ConteudoGemini {
  role: "user" | "model";
  parts: ParteGemini[];
}

// Única ferramenta do agente por enquanto: buscar e mandar a declaração
// (guia) mais recente já concluída do cliente da conversa. Só é oferecida ao
// Gemini quando a conversa já está vinculada a um cliente (ver acionarAgente).
const FERRAMENTA_DECLARACAO = {
  name: "enviar_declaracao",
  description:
    "Busca a declaração/guia mais recente já concluída do cliente desta conversa e devolve o link de entrega real, pra você passar pro cliente. Use sempre que o cliente pedir a declaração, a guia ou o documento dele.",
  parameters: { type: "OBJECT", properties: {}, required: [] },
};

// Nunca deixa o Gemini escolher livremente qual cliente/documento: a busca é
// sempre presa ao cliente já identificado pelo telefone da conversa.
async function buscarDeclaracaoParaEnvio(clienteId: string): Promise<Record<string, unknown>> {
  const obrigacao = await prisma.obrigacao.findFirst({
    where: {
      clienteId,
      nome: { contains: "declara", mode: "insensitive" },
      concluidaEm: { not: null },
    },
    orderBy: { competencia: "desc" },
    include: { protocolos: { orderBy: { numero: "desc" }, take: 1 } },
  });

  if (!obrigacao) {
    return { encontrada: false, motivo: "Nenhuma declaração concluída encontrada para este cliente." };
  }
  const protocolo = obrigacao.protocolos[0];
  if (!protocolo) {
    return {
      encontrada: false,
      motivo: "A declaração existe mas ainda não tem link de entrega gerado; oriente o cliente a falar com um atendente.",
    };
  }
  return {
    encontrada: true,
    nomeDocumento: obrigacao.nome,
    competencia: obrigacao.competencia ? obrigacao.competencia.toISOString().slice(0, 7) : null,
    link: linkPublico(protocolo.token),
  };
}

// Bloco de contexto montado na hora, antes das instruções cadastradas no
// AgenteIA (que cuidam de tom/serviços) — é isso que "modula" a conversa pelo
// cadastro do cliente.
function contextoCliente(cliente: Cliente | null): string {
  if (!cliente) {
    return [
      "DADOS DO CONTATO: este número de WhatsApp NÃO está cadastrado na base de clientes da Apta.",
      "Apresente a Apta Contabilidade e os serviços oferecidos normalmente.",
      "NÃO ofereça fazer o cadastro por aqui — cadastro de cliente novo é feito só por um atendente humano.",
      "Você não tem acesso a nenhuma ferramenta de buscar/enviar documento nesta conversa. Se pedirem declaração/guia, explique que esse serviço é exclusivo para clientes já cadastrados e ofereça transferir para um atendente humano caso a pessoa queira virar cliente.",
    ].join(" ");
  }
  return [
    `DADOS DO CONTATO: este número é de um cliente cadastrado — ${cliente.razaoSocial}${cliente.apelido ? ` (${cliente.apelido})` : ""}.`,
    cliente.regimeTributario ? `Regime tributário: ${cliente.regimeTributario}.` : "",
    "Cumprimente mencionando que já identificou o cadastro e pergunte como pode ajudar.",
    "Se o cliente pedir a declaração, a guia ou o documento dele, use a ferramenta enviar_declaracao e repasse o link exatamente como ela devolver, sem inventar nem alterar a URL. Se a ferramenta disser que não encontrou, avise o cliente com naturalidade e ofereça transferir para um atendente.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function chamarGemini(
  instrucoes: string,
  historicoInicial: ConteudoGemini[],
  opcoes: { clienteId: string | null }
): Promise<string> {
  const { apiKey, modelo } = await configGemini();
  if (!apiKey) {
    throw new Error("Gemini não configurado (tela Agentes e IA ou GEMINI_API_KEY)");
  }

  const ferramentas = opcoes.clienteId ? [{ functionDeclarations: [FERRAMENTA_DECLARACAO] }] : undefined;
  const contents: ConteudoGemini[] = [...historicoInicial];

  // No máximo 2 idas e vindas com ferramenta — suficiente pro único caso de
  // uso hoje, e evita loop infinito se o Gemini insistir em chamar de novo.
  const MAX_RODADAS_FERRAMENTA = 2;

  for (let rodada = 0; rodada <= MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instrucoes }] },
          contents,
          ...(ferramentas ? { tools: ferramentas } : {}),
        }),
      }
    );
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new Error(`Gemini respondeu ${resposta.status}: ${corpo.slice(0, 300)}`);
    }
    const dados = (await resposta.json()) as {
      candidates?: { content?: { parts?: ParteGemini[] } }[];
    };
    const parts = dados.candidates?.[0]?.content?.parts ?? [];
    const chamada = parts.find((parte) => parte.functionCall)?.functionCall;

    if (chamada && chamada.name === "enviar_declaracao" && opcoes.clienteId) {
      contents.push({ role: "model", parts });
      const resultado = await buscarDeclaracaoParaEnvio(opcoes.clienteId);
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: "enviar_declaracao", response: resultado } }],
      });
      continue;
    }

    const texto = parts
      .map((parte) => parte.text ?? "")
      .join("")
      .trim();
    if (!texto) {
      throw new Error("Gemini não retornou texto na resposta");
    }
    return texto;
  }
  throw new Error("Gemini não finalizou a resposta depois de usar a ferramenta");
}

// O Gemini às vezes responde 503 ("sobrecarregado") por alguns segundos só —
// antes de devolver a conversa pro humano, vale tentar de novo um punhado de
// vezes, com uma pausa curta entre elas.
const TENTATIVAS_GEMINI = 4;
const PAUSA_ENTRE_TENTATIVAS_MS = 4_000;

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chamarGeminiComRetentativas(
  instrucoes: string,
  historico: ConteudoGemini[],
  opcoes: { clienteId: string | null }
): Promise<string> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= TENTATIVAS_GEMINI; tentativa++) {
    try {
      return await chamarGemini(instrucoes, historico, opcoes);
    } catch (error) {
      ultimoErro = error;
      console.warn(
        `[agente] Tentativa ${tentativa}/${TENTATIVAS_GEMINI} falhou: ${error instanceof Error ? error.message : String(error)}`
      );
      if (tentativa < TENTATIVAS_GEMINI) {
        await aguardar(PAUSA_ENTRE_TENTATIVAS_MS);
      }
    }
  }
  throw ultimoErro;
}

async function voltarParaHumano(conversaId: string, motivo: string) {
  console.error(`[agente] Conversa ${conversaId}: ${motivo}`);
  await registrarSistema(conversaId, "O agente de IA não conseguiu responder agora; a conversa voltou para atendimento humano.");
  await prisma.conversa.update({ where: { id: conversaId }, data: { modo: "HUMANO" } });
}

export async function acionarAgente(conversaId: string): Promise<void> {
  if (!(await motorAgenteConfigurado())) {
    console.log(`[agente] Conversa ${conversaId} em modo agente, mas o motor ainda não está configurado.`);
    return;
  }

  const conversa = await prisma.conversa.findUnique({
    where: { id: conversaId },
    include: { agente: true, cliente: true },
  });
  if (!conversa || conversa.modo !== "AGENTE" || !conversa.agente) {
    return;
  }
  if (!conversa.agente.ativo) {
    await voltarParaHumano(conversaId, `agente "${conversa.agente.nome}" está desativado`);
    return;
  }

  // "desc" + take pra pegar as HISTORICO_MAX mais RECENTES (não as mais
  // antigas); depois reverte pra ordem cronológica que a API espera.
  const mensagensRecentes = await prisma.mensagem.findMany({
    where: { conversaId, interna: false, autor: { in: ["CLIENTE", "AGENTE", "ATENDENTE"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORICO_MAX,
    select: { autor: true, texto: true },
  });
  const mensagens = mensagensRecentes.reverse();
  const historico: ConteudoGemini[] = mensagens
    .filter((mensagem) => mensagem.texto)
    .map((mensagem) => ({
      role: mensagem.autor === "CLIENTE" ? "user" : "model",
      parts: [{ text: mensagem.texto! }],
    }));
  if (historico.length === 0 || historico[0].role !== "user") {
    return; // precisa de pelo menos uma mensagem do cliente para responder
  }

  const instrucoesFinais = `${contextoCliente(conversa.cliente)}\n\n${conversa.agente.instrucoes}`;

  try {
    const resposta = await chamarGeminiComRetentativas(instrucoesFinais, historico, {
      clienteId: conversa.clienteId,
    });
    await enviarMensagem({ conversaId, texto: resposta, autor: "AGENTE", agenteId: conversa.agente.id });
  } catch (error) {
    await voltarParaHumano(conversaId, error instanceof Error ? error.message : String(error));
  }
}
