// Catálogo dos tipos de notificação: rótulo e descrição (tela de
// preferências), categoria (filtro), quem pode receber e o padrão de canais.

export type Severidade = "info" | "sucesso" | "aviso" | "erro";

export interface TipoNotificacao {
  rotulo: string;
  descricao: string;
  categoria: string;
  /** Só gestores/admins recebem (e só eles veem na tela de preferências). */
  gestao?: boolean;
  padrao: { app: boolean; email: boolean };
}

export const TIPOS_NOTIFICACAO = {
  entrega_atribuida: {
    rotulo: "Entrega atribuída a você",
    descricao: "Alguém colocou você como responsável por uma entrega.",
    categoria: "obrigações",
    padrao: { app: true, email: false },
  },
  entrega_vence_amanha: {
    rotulo: "Entrega vence amanhã",
    descricao: "Lembrete na véspera do prazo legal das suas entregas.",
    categoria: "obrigações",
    padrao: { app: true, email: false },
  },
  entrega_vence_hoje: {
    rotulo: "Entrega vence hoje",
    descricao: "No dia do prazo legal, se a entrega ainda estiver aberta.",
    categoria: "obrigações",
    padrao: { app: true, email: true },
  },
  entrega_atrasada: {
    rotulo: "Entrega atrasada",
    descricao: "O prazo legal passou e a entrega não foi concluída nem justificada.",
    categoria: "obrigações",
    padrao: { app: true, email: true },
  },
  plano_vencido: {
    rotulo: "Plano de ação vencido",
    descricao: "A data prometida no plano de ação de uma entrega atrasada passou.",
    categoria: "obrigações",
    padrao: { app: true, email: false },
  },
  comentario_entrega: {
    rotulo: "Comentário em entrega sua",
    descricao: "Alguém comentou numa entrega sob sua responsabilidade.",
    categoria: "obrigações",
    padrao: { app: true, email: false },
  },
  atraso_justificado: {
    rotulo: "Atraso justificado",
    descricao: "Um analista registrou justificativa e plano de ação para uma entrega atrasada.",
    categoria: "obrigações",
    gestao: true,
    padrao: { app: true, email: false },
  },
  resumo_atrasadas: {
    rotulo: "Resumo diário de atrasos",
    descricao: "Uma vez por dia, quantas entregas do escritório estão atrasadas.",
    categoria: "obrigações",
    gestao: true,
    padrao: { app: true, email: false },
  },
  guia_lida: {
    rotulo: "Cliente abriu a guia",
    descricao: "O cliente abriu os documentos de um protocolo seu.",
    categoria: "entregas ao cliente",
    padrao: { app: true, email: false },
  },
  guia_nao_lida: {
    rotulo: "Guia ainda não lida",
    descricao: "O protocolo foi enviado há 3 dias e o cliente não abriu.",
    categoria: "entregas ao cliente",
    padrao: { app: true, email: false },
  },
  envio_falhou: {
    rotulo: "Falha no envio ao cliente",
    descricao: "O e-mail do protocolo não foi entregue.",
    categoria: "entregas ao cliente",
    padrao: { app: true, email: true },
  },
  atendimento_atribuido: {
    rotulo: "Atendimento para você",
    descricao: "Um atendimento ou conversa foi direcionado a você.",
    categoria: "atendimento",
    padrao: { app: true, email: false },
  },
  pendencia_cliente: {
    rotulo: "Pendência de cliente vencida",
    descricao: "Uma pendência que você registrou passou do prazo e segue aberta.",
    categoria: "clientes",
    padrao: { app: true, email: false },
  },
  clientes_sem_email: {
    rotulo: "Clientes sem e-mail de contato",
    descricao: "Toda segunda-feira, se houver clientes sem contato com e-mail (o protocolo não tem para quem ir).",
    categoria: "clientes",
    gestao: true,
    padrao: { app: true, email: false },
  },
  certificado_vencendo: {
    rotulo: "Certificado digital vencendo",
    descricao: "Faltam 30, 15 ou 7 dias para o certificado de um cliente vencer.",
    categoria: "SIEG e certificados",
    gestao: true,
    padrao: { app: true, email: true },
  },
  certificado_vencido: {
    rotulo: "Certificado digital vencido",
    descricao: "O certificado venceu: a SIEG para de capturar as notas desse cliente.",
    categoria: "SIEG e certificados",
    gestao: true,
    padrao: { app: true, email: true },
  },
  sieg_acesso: {
    rotulo: "Acesso à SIEG vencendo",
    descricao: "A autorização da SIEG vence em breve ou já venceu.",
    categoria: "SIEG e certificados",
    gestao: true,
    padrao: { app: true, email: true },
  },
  sieg_erro: {
    rotulo: "Erro na busca da SIEG",
    descricao: "A busca noturna de notas na SIEG terminou com erros.",
    categoria: "SIEG e certificados",
    gestao: true,
    padrao: { app: true, email: false },
  },
  conta_alterada: {
    rotulo: "Mudança na sua conta",
    descricao: "Seu perfil ou setor foi alterado por um administrador.",
    categoria: "conta",
    padrao: { app: true, email: false },
  },
} satisfies Record<string, TipoNotificacao>;

export type TipoId = keyof typeof TIPOS_NOTIFICACAO;
export const ehTipo = (t: string): t is TipoId => t in TIPOS_NOTIFICACAO;
