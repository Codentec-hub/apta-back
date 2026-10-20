// Vínculo de obrigações a uma empresa (ClienteObrigacao), compartilhado pelo
// cadastro de obrigações da empresa e pelo cadastro de clientes.
import { prisma } from "../prisma.js";
import { gerarJanela, removerFuturasIntocadas } from "./gerar-entregas.js";

// Aloca obrigações na empresa (reativa se já existiam inativas) e gera as
// pendências da janela.
export async function alocar(clienteId: string, tipoIds: string[]): Promise<void> {
  await prisma.$transaction([
    // Reativar conta como vínculo novo: não gera o que venceu enquanto inativa.
    prisma.clienteObrigacao.updateMany({
      where: { clienteId, tipoId: { in: tipoIds }, ativa: false },
      data: { ativa: true, geraDesde: new Date() },
    }),
    prisma.clienteObrigacao.createMany({
      data: tipoIds.map((tipoId) => ({ clienteId, tipoId })),
      skipDuplicates: true,
    }),
  ]);
  await gerarJanela({ clienteId });
}

// Aplicar regime: SUBSTITUI as obrigações da empresa pelas do regime — as
// que não estão no regime ficam inativas (o histórico de entregas fica).
export async function aplicarRegime(
  clienteId: string,
  regime: { nome: string; obrigacoes: { tipoId: string }[] }
): Promise<number> {
  const tipoIds = regime.obrigacoes.map((o) => o.tipoId);
  const saindo = await prisma.clienteObrigacao.findMany({
    where: { clienteId, ativa: true, tipoId: { notIn: tipoIds } },
    select: { tipoId: true },
  });
  if (saindo.length > 0) {
    await removerFuturasIntocadas({ clienteId, tipoId: { in: saindo.map((s) => s.tipoId) } });
  }
  await prisma.$transaction([
    prisma.clienteObrigacao.updateMany({
      where: { clienteId, tipoId: { notIn: tipoIds } },
      data: { ativa: false },
    }),
    prisma.cliente.update({ where: { id: clienteId }, data: { regimeTributario: regime.nome } }),
  ]);
  if (tipoIds.length > 0) await alocar(clienteId, tipoIds);
  return tipoIds.length;
}

// Usado pelo cadastro de clientes: o regime vem como texto (nome).
export async function aplicarRegimePorNome(clienteId: string, nome: string | null | undefined): Promise<number | null> {
  if (!nome) return null;
  const regime = await prisma.regimeTributario.findUnique({ where: { nome }, include: { obrigacoes: true } });
  if (!regime) return null;
  return aplicarRegime(clienteId, regime);
}

// Cliente inativado: some das pendências futuras que ninguém tocou (o que já
// tem trabalho registrado fica, para não perder histórico).
export async function aoInativarCliente(clienteId: string): Promise<void> {
  await removerFuturasIntocadas({ clienteId });
}

// Reativado: volta a gerar a partir de hoje, sem cobrar o que venceu
// enquanto esteve inativo.
export async function aoReativarCliente(clienteId: string): Promise<void> {
  await prisma.clienteObrigacao.updateMany({ where: { clienteId, ativa: true }, data: { geraDesde: new Date() } });
  await gerarJanela({ clienteId });
}
