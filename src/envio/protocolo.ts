// Dados de um protocolo de entrega no formato do e-mail ao cliente — usado
// tanto no envio (rota de protocolos) quanto no lembrete de guia não lida.
import { prisma } from "../prisma.js";
import type { DadosMensagemProtocolo } from "./mensagem-protocolo.js";

export async function dadosDoProtocolo(protocoloId: string, analistaId: string | null): Promise<DadosMensagemProtocolo> {
  const protocolo = await prisma.protocoloEntrega.findUniqueOrThrow({
    where: { id: protocoloId },
    include: {
      obrigacao: {
        select: {
          nome: true,
          competencia: true,
          prazo: true,
          tipo: { select: { competenciaReferente: true } },
          cliente: { select: { razaoSocial: true } },
          documentos: { select: { nomeArquivo: true }, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  const { obrigacao } = protocolo;
  const analista = analistaId
    ? await prisma.usuario.findUnique({ where: { id: analistaId }, select: { nome: true, email: true } })
    : null;

  return {
    numero: protocolo.numero,
    token: protocolo.token,
    destinatarioNome: protocolo.destinatarioNome,
    destinatarioEmail: protocolo.destinatarioEmail ?? "",
    obrigacao: {
      nome: obrigacao.nome,
      competencia: obrigacao.competencia,
      competenciaAnual: Math.abs(obrigacao.tipo?.competenciaReferente ?? 0) === 12,
      prazo: obrigacao.prazo,
    },
    empresa: obrigacao.cliente,
    documentos: obrigacao.documentos.map((d) => d.nomeArquivo),
    analista,
  };
}
