// Camada de provedor do WhatsApp. O resto do sistema só fala com esta
// interface; trocar de provedor (Cloud API oficial da Meta, Evolution API...)
// é escrever outra implementação aqui.
//
// WHATSAPP_PROVEDOR:
// - "simulador" (padrão): não envia nada. As mensagens "enviadas" ficam
//   entregues/lidas sozinhas depois de alguns segundos, e a tela tem um botão
//   para simular a chegada de mensagens de clientes. Serve para usar e
//   demonstrar o atendimento antes de existir um número de verdade.
// - "evolution": instância própria da Evolution API (self-hosted, WhatsApp
//   não-oficial via multi-device). Precisa de EVOLUTION_API_URL,
//   EVOLUTION_API_KEY e EVOLUTION_INSTANCE já conectada (QR Code escaneado
//   no Manager). Texto livre sem limite de janela de 24h.
import { prisma } from "../prisma.js";

export interface ResultadoEnvio {
  idExterno: string | null;
}

export interface ProvedorWhatsApp {
  nome: string;
  simulador: boolean;
  // A API oficial só aceita texto livre até 24h depois da última mensagem do
  // cliente; fora disso, só modelos aprovados pela Meta.
  exigeJanela24h: boolean;
  enviarTexto(telefone: string, texto: string): Promise<ResultadoEnvio>;
}

const simulador: ProvedorWhatsApp = {
  nome: "simulador",
  simulador: true,
  exigeJanela24h: false,
  async enviarTexto(telefone, texto) {
    console.log(`[whatsapp:simulador] Para ${telefone}: ${texto}`);
    return { idExterno: `sim-${crypto.randomUUID()}` };
  },
};

// Config do banco (tela "Agentes e IA") tem prioridade; EVOLUTION_API_URL/
// EVOLUTION_API_KEY/EVOLUTION_INSTANCE no ambiente servem de valor padrão
// enquanto ninguém configurar pela tela.
async function configEvolution() {
  const config = await prisma.configuracaoEvolution.findUnique({ where: { id: 1 } });
  const url = config?.url || process.env.EVOLUTION_API_URL;
  const apiKey = config?.apiKey || process.env.EVOLUTION_API_KEY;
  const instance = config?.instancia || process.env.EVOLUTION_INSTANCE;
  if (!url || !apiKey || !instance) {
    throw new Error("Evolution API não configurada (tela Agentes e IA ou EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE)");
  }
  return { url: url.replace(/\/+$/, ""), apiKey, instance };
}

const evolution: ProvedorWhatsApp = {
  nome: "evolution",
  simulador: false,
  exigeJanela24h: false,
  async enviarTexto(telefone, texto) {
    const { url, apiKey, instance } = await configEvolution();
    const resposta = await fetch(`${url}/message/sendText/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number: telefone, text: texto }),
    });
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new Error(`Evolution API respondeu ${resposta.status}: ${corpo.slice(0, 300)}`);
    }
    const dados = (await resposta.json()) as { key?: { id?: string } };
    return { idExterno: dados.key?.id ?? null };
  },
};

export function provedorWhatsApp(): ProvedorWhatsApp {
  const nome = process.env.WHATSAPP_PROVEDOR ?? "simulador";
  if (nome === "evolution") {
    return evolution;
  }
  if (nome !== "simulador") {
    console.warn(`[whatsapp] Provedor "${nome}" ainda não implementado; usando o simulador.`);
  }
  return simulador;
}
