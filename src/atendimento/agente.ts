// Motor do Agente Apta: chamado quando chega mensagem numa conversa em modo
// AGENTE. Usa a API do Gemini (Google) com as instruções cadastradas no
// AgenteIA como contexto fixo, mais o histórico recente da conversa. Se o
// Gemini falhar ou a chave não estiver configurada, a conversa volta sozinha
// para o modo HUMANO em vez de ficar "presa" sem resposta.
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

interface ConteudoGemini {
  role: "user" | "model";
  parts: { text: string }[];
}

async function chamarGemini(instrucoes: string, historico: ConteudoGemini[]): Promise<string> {
  const { apiKey, modelo } = await configGemini();
  if (!apiKey) {
    throw new Error("Gemini não configurado (tela Agentes e IA ou GEMINI_API_KEY)");
  }
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instrucoes }] },
        contents: historico,
      }),
    }
  );
  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => "");
    throw new Error(`Gemini respondeu ${resposta.status}: ${corpo.slice(0, 300)}`);
  }
  const dados = (await resposta.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const texto = dados.candidates?.[0]?.content?.parts
    ?.map((parte) => parte.text ?? "")
    .join("")
    .trim();
  if (!texto) {
    throw new Error("Gemini não retornou texto na resposta");
  }
  return texto;
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

  const conversa = await prisma.conversa.findUnique({ where: { id: conversaId }, include: { agente: true } });
  if (!conversa || conversa.modo !== "AGENTE" || !conversa.agente) {
    return;
  }
  if (!conversa.agente.ativo) {
    await voltarParaHumano(conversaId, `agente "${conversa.agente.nome}" está desativado`);
    return;
  }

  const mensagens = await prisma.mensagem.findMany({
    where: { conversaId, interna: false, autor: { in: ["CLIENTE", "AGENTE", "ATENDENTE"] } },
    orderBy: { createdAt: "asc" },
    take: HISTORICO_MAX,
    select: { autor: true, texto: true },
  });
  const historico: ConteudoGemini[] = mensagens
    .filter((mensagem) => mensagem.texto)
    .map((mensagem) => ({
      role: mensagem.autor === "CLIENTE" ? "user" : "model",
      parts: [{ text: mensagem.texto! }],
    }));
  if (historico.length === 0 || historico[0].role !== "user") {
    return; // precisa de pelo menos uma mensagem do cliente para responder
  }

  try {
    const resposta = await chamarGemini(conversa.agente.instrucoes, historico);
    await enviarMensagem({ conversaId, texto: resposta, autor: "AGENTE", agenteId: conversa.agente.id });
  } catch (error) {
    await voltarParaHumano(conversaId, error instanceof Error ? error.message : String(error));
  }
}
