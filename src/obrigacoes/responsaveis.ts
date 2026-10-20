// Quando muda um responsável (do setor, do cliente no setor ou da obrigação
// na empresa), as entregas pendentes já geradas acompanham. Regra igual à
// da geração: obrigação na empresa → cliente no setor → padrão do setor.
// Só mexe nas que estão sem responsável ou com um dos responsáveis
// "anteriores" (o que a regra dava antes): troca feita à mão fica.
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

export async function redistribuirPendentes(
  escopo: Prisma.ObrigacaoWhereInput,
  anteriores: (string | null | undefined)[]
): Promise<number> {
  const ids = [...new Set(anteriores.filter((a): a is string => Boolean(a)))];
  const pendentes = await prisma.obrigacao.findMany({
    where: {
      ...escopo,
      concluidaEm: null,
      dispensada: false,
      OR: [{ responsavelId: null }, ...(ids.length > 0 ? [{ responsavelId: { in: ids } }] : [])],
    },
    select: { id: true, clienteId: true, setorId: true, tipoId: true, responsavelId: true },
  });
  if (pendentes.length === 0) return 0;

  const clienteIds = [...new Set(pendentes.map((p) => p.clienteId))];
  const [vinculos, doCliente, setores] = await Promise.all([
    prisma.clienteObrigacao.findMany({
      where: { clienteId: { in: clienteIds }, responsavelId: { not: null } },
      select: { clienteId: true, tipoId: true, responsavelId: true },
    }),
    prisma.clienteResponsavel.findMany({ where: { clienteId: { in: clienteIds } } }),
    prisma.setor.findMany({ select: { id: true, responsavelId: true } }),
  ]);
  const porObrigacao = new Map(vinculos.map((v) => [`${v.clienteId}:${v.tipoId}`, v.responsavelId]));
  const porCliente = new Map(doCliente.map((r) => [`${r.clienteId}:${r.setorId}`, r.usuarioId]));
  const porSetor = new Map(setores.map((s) => [s.id, s.responsavelId]));

  const grupos = new Map<string | null, string[]>();
  for (const p of pendentes) {
    const novo =
      (p.tipoId ? porObrigacao.get(`${p.clienteId}:${p.tipoId}`) : null) ??
      porCliente.get(`${p.clienteId}:${p.setorId}`) ??
      porSetor.get(p.setorId) ??
      null;
    if (novo === p.responsavelId) continue;
    grupos.set(novo, [...(grupos.get(novo) ?? []), p.id]);
  }

  let total = 0;
  for (const [responsavelId, idsGrupo] of grupos) {
    const { count } = await prisma.obrigacao.updateMany({ where: { id: { in: idsGrupo } }, data: { responsavelId } });
    total += count;
  }
  return total;
}
