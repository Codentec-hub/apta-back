import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { calcularEntrega, mesAtual, somarMeses } from "./prazos.js";

// Quantos meses de entrega à frente ficam gerados como pendência (o
// Acessórias mostra "Próx. 30 dias" e "Futuras 30d+" no cadastro da empresa,
// ou seja, as pendências futuras já existem).
export const MESES_A_FRENTE = 12;

export type FiltroGeracao = { clienteId?: string; tipoId?: string };

// Gera as entregas de um mês de entrega para todas as obrigações ativas das
// empresas ativas. Idempotente: a unique (cliente, tipo, competência) impede
// duplicar, então pode rodar quantas vezes for preciso.
export async function gerarEntregasDoMes(ano: number, mes: number, filtro: FiltroGeracao = {}): Promise<number> {
  const alocadas = await prisma.clienteObrigacao.findMany({
    where: {
      ativa: true,
      clienteId: filtro.clienteId,
      tipoId: filtro.tipoId,
      cliente: { ativo: true },
      tipo: { ativo: true },
    },
    include: {
      tipo: { include: { setor: { select: { responsavelId: true } } } },
      cliente: { include: { responsaveis: true } },
    },
  });

  const dados: Prisma.ObrigacaoCreateManyInput[] = [];
  for (const a of alocadas) {
    const entrega = calcularEntrega(a.tipo, ano, mes);
    if (!entrega) continue;
    // Responsável pelo prazo: o da obrigação na empresa → o do departamento
    // no cadastro do cliente → o responsável padrão do departamento.
    const responsavelDoCliente = a.cliente.responsaveis.find((r) => r.setorId === a.tipo.setorId)?.usuarioId;
    dados.push({
      nome: a.tipo.nome,
      ...entrega,
      clienteId: a.clienteId,
      setorId: a.tipo.setorId,
      tipoId: a.tipoId,
      responsavelId: a.responsavelId ?? responsavelDoCliente ?? a.tipo.setor.responsavelId ?? null,
    });
  }

  if (dados.length === 0) return 0;
  const { count } = await prisma.obrigacao.createMany({ data: dados, skipDuplicates: true });
  return count;
}

// Mantém as pendências do mês corrente até MESES_A_FRENTE meses à frente.
export async function gerarJanela(filtro: FiltroGeracao = {}): Promise<number> {
  const { ano, mes } = mesAtual();
  let total = 0;
  for (let i = 0; i < MESES_A_FRENTE; i++) {
    const m = somarMeses(ano, mes, i);
    total += await gerarEntregasDoMes(m.ano, m.mes, filtro);
  }
  return total;
}

// Botão "Retro" do Acessórias: gera pendências retroativas desde um mês de
// entrega passado até o mês anterior ao corrente.
export async function gerarRetroativas(desde: { ano: number; mes: number }, filtro: FiltroGeracao = {}): Promise<number> {
  const atual = mesAtual();
  let total = 0;
  let m = desde;
  while (m.ano < atual.ano || (m.ano === atual.ano && m.mes < atual.mes)) {
    total += await gerarEntregasDoMes(m.ano, m.mes, filtro);
    m = somarMeses(m.ano, m.mes, 1);
  }
  return total;
}

// Pendências futuras que ninguém tocou (sem entrega, dispensa, justificativa,
// comentário nem alteração registrada) podem ser refeitas/removidas quando o
// cadastro muda, sem perder trabalho de ninguém.
export async function removerFuturasIntocadas(where: Prisma.ObrigacaoWhereInput): Promise<number> {
  const { count } = await prisma.obrigacao.deleteMany({
    where: {
      ...where,
      prazo: { gt: new Date() },
      concluidaEm: null,
      dispensada: false,
      atraso: null,
      logs: { none: {} },
      comentarios: { none: {} },
    },
  });
  return count;
}

// Depois de alterar a regra de uma obrigação no cadastro.
export async function recalcularFuturas(filtro: FiltroGeracao): Promise<{ removidas: number; criadas: number }> {
  const removidas = await removerFuturasIntocadas({ tipoId: filtro.tipoId, clienteId: filtro.clienteId });
  const criadas = await gerarJanela(filtro);
  return { removidas, criadas };
}

// Roda na subida da API e a cada 6 horas.
export function agendarGeracaoAutomatica(): void {
  const rodar = () => {
    gerarJanela()
      .then((criadas) => {
        if (criadas > 0) console.log(`[entregas] ${criadas} pendências geradas`);
      })
      .catch((erro) => console.error("[entregas] falha na geração automática", erro));
  };
  rodar();
  setInterval(rodar, 6 * 60 * 60 * 1000).unref();
}
