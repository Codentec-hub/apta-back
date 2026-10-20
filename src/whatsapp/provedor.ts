// Camada de provedor do WhatsApp. O resto do sistema só fala com esta
// interface; trocar de provedor (Cloud API oficial da Meta, Evolution API...)
// é escrever outra implementação aqui.
//
// WHATSAPP_PROVEDOR:
// - "simulador" (padrão): não envia nada. As mensagens "enviadas" ficam
//   entregues/lidas sozinhas depois de alguns segundos, e a tela tem um botão
//   para simular a chegada de mensagens de clientes. Serve para usar e
//   demonstrar o atendimento antes de existir um número de verdade.

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

export function provedorWhatsApp(): ProvedorWhatsApp {
  const nome = process.env.WHATSAPP_PROVEDOR ?? "simulador";
  if (nome !== "simulador") {
    console.warn(`[whatsapp] Provedor "${nome}" ainda não implementado; usando o simulador.`);
  }
  return simulador;
}
