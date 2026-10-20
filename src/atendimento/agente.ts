// Ponto de entrada do Agente Apta: chamado quando chega mensagem numa
// conversa em modo AGENTE. O motor (modelo de IA + ferramentas que consultam
// obrigações, protocolos etc.) entra aqui quando os agentes forem
// cadastrados; até lá, a conversa só fica registrada como "com o agente".

export function motorAgenteConfigurado(): boolean {
  return false;
}

export async function acionarAgente(conversaId: string): Promise<void> {
  if (!motorAgenteConfigurado()) {
    console.log(`[agente] Conversa ${conversaId} em modo agente, mas o motor ainda não está configurado.`);
  }
}
