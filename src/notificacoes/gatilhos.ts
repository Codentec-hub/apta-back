// Avisos que nascem na hora em que algo muda no banco (extensão do Prisma),
// valendo para qualquer rota ou rotina que grave esses dados:
//  - entrega atribuída a alguém (por outra pessoa);
//  - comentário numa entrega de outra pessoa;
//  - justificativa de atraso (para a gestão);
//  - cliente abriu a guia / falha no envio do protocolo;
//  - atendimento direcionado a alguém;
//  - perfil ou setor de um usuário alterado pelo admin.
// Os avisos são disparados sem esperar (não atrasam a resposta) e nunca
// derrubam a gravação original.
import type { PrismaClient } from "@prisma/client";
import { contextoAtual } from "../auditoria/contexto.js";
import { idsDaGestao, notificar } from "./notificar.js";

const MODELOS = new Set(["Obrigacao", "ComentarioEntrega", "Atraso", "ProtocoloEntrega", "Atendimento", "Usuario"]);
const OPERACOES = new Set(["create", "update", "upsert"]);
const PERFIL: Record<string, string> = { ADMIN: "Administrador", GESTOR: "Gestor", OPERACIONAL: "Operacional" };

const dataBr = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" });
const buscaCliente = (nome: string) => `/dashboard/obrigacoes?busca=${encodeURIComponent(nome)}`;

async function aoGravar(base: PrismaClient, modelo: string, antes: any, depois: any): Promise<void> {
  const ator = contextoAtual()?.usuarioId ?? null;
  const nomeAtor = contextoAtual()?.usuarioNome ?? "Alguém";

  switch (modelo) {
    case "Obrigacao": {
      // Só atribuição feita por uma pessoa (a geração automática não avisa).
      if (!ator || !depois.responsavelId || depois.responsavelId === antes?.responsavelId) return;
      if (depois.responsavelId === ator || depois.concluidaEm || depois.dispensada) return;
      const cliente = await base.cliente.findUnique({ where: { id: depois.clienteId }, select: { razaoSocial: true } });
      await notificar([depois.responsavelId], {
        tipo: "entrega_atribuida",
        titulo: `Nova entrega para você: ${depois.nome}`,
        mensagem: `${nomeAtor} atribuiu a você "${depois.nome}" de ${cliente?.razaoSocial ?? "um cliente"}, com prazo em ${dataBr(depois.prazo)}.`,
        href: buscaCliente(cliente?.razaoSocial ?? depois.nome),
        chave: `atribuida:${depois.id}:${depois.responsavelId}`,
        dados: { obrigacaoId: depois.id },
      });
      return;
    }
    case "ComentarioEntrega": {
      if (antes) return; // só comentário novo
      const o = await base.obrigacao.findUnique({
        where: { id: depois.obrigacaoId },
        select: { id: true, nome: true, responsavelId: true, cliente: { select: { razaoSocial: true } } },
      });
      if (!o?.responsavelId || o.responsavelId === (depois.usuarioId ?? ator)) return;
      await notificar([o.responsavelId], {
        tipo: "comentario_entrega",
        titulo: `Comentário em ${o.nome}`,
        mensagem: `${nomeAtor} comentou em "${o.nome}" (${o.cliente.razaoSocial}): ${String(depois.texto).slice(0, 200)}`,
        href: buscaCliente(o.cliente.razaoSocial),
        chave: `comentario:${depois.id}`,
        dados: { obrigacaoId: o.id },
      });
      return;
    }
    case "Atraso": {
      if (antes) return;
      const o = await base.obrigacao.findUnique({
        where: { id: depois.obrigacaoId },
        select: { id: true, nome: true, cliente: { select: { razaoSocial: true } } },
      });
      if (!o) return;
      const gestao = (await idsDaGestao()).filter((id) => id !== ator);
      await notificar(gestao, {
        tipo: "atraso_justificado",
        titulo: `Atraso justificado: ${o.nome}`,
        mensagem: `${nomeAtor} justificou o atraso de "${o.nome}" (${o.cliente.razaoSocial}). Plano de ação prometido para ${dataBr(depois.prazoPrometido)}. Motivo: ${String(depois.justificativa).slice(0, 160)}`,
        href: buscaCliente(o.cliente.razaoSocial),
        severidade: "aviso",
        chave: `atraso:${depois.id}`,
        dados: { obrigacaoId: o.id },
      });
      return;
    }
    case "ProtocoloEntrega": {
      const abriu = !antes?.lidoEm && depois.lidoEm;
      const falhou = antes && antes.status !== "FALHA" && depois.status === "FALHA";
      if (!abriu && !falhou) return;
      const o = await base.obrigacao.findUnique({
        where: { id: depois.obrigacaoId },
        select: { id: true, nome: true, responsavelId: true, cliente: { select: { razaoSocial: true } } },
      });
      if (!o) return;
      const destino = [depois.usuarioId ?? o.responsavelId];
      if (abriu) {
        await notificar(destino, {
          tipo: "guia_lida",
          titulo: `${depois.destinatarioNome} abriu ${o.nome}`,
          mensagem: `O cliente ${o.cliente.razaoSocial} abriu os documentos do protocolo nº ${depois.numero} (${o.nome}).`,
          href: buscaCliente(o.cliente.razaoSocial),
          severidade: "sucesso",
          chave: `lida:${depois.id}`,
          dados: { obrigacaoId: o.id, protocoloId: depois.id },
        });
      } else {
        await notificar(destino, {
          tipo: "envio_falhou",
          titulo: `Falha ao enviar ${o.nome}`,
          mensagem: `O e-mail do protocolo nº ${depois.numero} para ${depois.destinatarioNome} (${o.cliente.razaoSocial}) não foi entregue: ${String(depois.erroEnvio ?? "sem detalhes").slice(0, 200)}`,
          href: buscaCliente(o.cliente.razaoSocial),
          severidade: "erro",
          chave: `falha:${depois.id}:${depois.erroEnvio ?? ""}`.slice(0, 250),
          dados: { obrigacaoId: o.id, protocoloId: depois.id },
        });
      }
      return;
    }
    case "Atendimento": {
      if (!depois.responsavelId || depois.responsavelId === antes?.responsavelId || depois.responsavelId === ator) return;
      if (depois.status === "FINALIZADO") return;
      const cliente = depois.clienteId
        ? await base.cliente.findUnique({ where: { id: depois.clienteId }, select: { razaoSocial: true } })
        : null;
      await notificar([depois.responsavelId], {
        tipo: "atendimento_atribuido",
        titulo: `Atendimento para você${cliente ? `: ${cliente.razaoSocial}` : ""}`,
        mensagem: `${ator ? nomeAtor : "O sistema"} direcionou a você um atendimento${cliente ? ` de ${cliente.razaoSocial}` : ""}${depois.motivo ? ` — ${String(depois.motivo).slice(0, 120)}` : ""}.`,
        href: depois.conversaId ? `/dashboard/atendimento?conversa=${depois.conversaId}` : "/dashboard/atendimento",
        chave: `atendimento:${depois.id}:${depois.responsavelId}`,
        dados: { atendimentoId: depois.id },
      });
      return;
    }
    case "Usuario": {
      if (!antes || !ator || depois.id === ator) return;
      const mudouPerfil = antes.perfil !== depois.perfil;
      const mudouSetor = antes.setorId !== depois.setorId;
      if (!mudouPerfil && !mudouSetor) return;
      const setor = mudouSetor && depois.setorId
        ? await base.setor.findUnique({ where: { id: depois.setorId }, select: { nome: true } })
        : null;
      const partes = [
        mudouPerfil ? `perfil agora é ${PERFIL[depois.perfil] ?? depois.perfil}` : null,
        mudouSetor ? `setor agora é ${setor?.nome ?? "nenhum"}` : null,
      ].filter(Boolean);
      await notificar([depois.id], {
        tipo: "conta_alterada",
        titulo: "Sua conta foi alterada",
        mensagem: `${nomeAtor} alterou sua conta: ${partes.join(" e ")}.`,
        href: "/dashboard",
        chave: `conta:${depois.id}:${Date.now()}`,
      });
      return;
    }
    default:
      return;
  }
}

export function comGatilhos<T extends { $extends: PrismaClient["$extends"] }>(cliente: T, base: PrismaClient) {
  return (cliente as unknown as PrismaClient).$extends({
    name: "gatilhos-notificacao",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !MODELOS.has(model) || !OPERACOES.has(operation)) return query(args);
          const delegado = (base as any)[model.charAt(0).toLowerCase() + model.slice(1)];
          const a = args as any;
          const antes = operation === "create" ? null : await delegado.findUnique({ where: a.where }).catch(() => null);
          const resultado: any = await query(args);
          const id = resultado?.id ?? antes?.id;
          if (id) {
            void delegado
              .findUnique({ where: { id } })
              .then((depois: unknown) => (depois ? aoGravar(base, model, antes, depois) : undefined))
              .catch((error: unknown) => console.error("[notificacoes] gatilho falhou", model, error));
          }
          return resultado;
        },
      },
    },
  });
}
