// Antes de cadastrar (ou alterar) um lead: o número, o CNPJ ou o e-mail já
// existem em outro lead, num cliente da casa ou numa conversa em andamento?
// Telefone repetido em outro lead bloqueia; o resto é aviso que a pessoa
// precisa confirmar ("cadastrar mesmo assim").
import { conversaPelaChave, identificarContato } from "../atendimento/conversas.js";
import { prisma } from "../prisma.js";
import { chaveTelefone, normalizarTelefone } from "../whatsapp/telefone.js";
import { STATUS_ROTULO } from "./leads.js";

export type TipoAviso = "lead_telefone" | "lead_cnpj" | "lead_email" | "cliente_cnpj" | "contato_cliente" | "conversa";

export interface AvisoDuplicidade {
  tipo: TipoAviso;
  /** true = não deixa salvar; false = só com confirmação. */
  bloqueia: boolean;
  mensagem: string;
  leadId?: string;
  clienteId?: string;
  conversaId?: string;
}

const ENCERRADO = new Set(["FORA_DO_PERFIL", "DESCARTADO"]);

function dv(base: string, pesos: number[]): number {
  const soma = [...base].reduce((acc, d, i) => acc + Number(d) * pesos[i]!, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor: string): boolean {
  const d = valor.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  return dv(d.slice(0, 12), p1) === Number(d[12]) && dv(d.slice(0, 13), [6, ...p1]) === Number(d[13]);
}

/** CNPJ válido encontrado no texto (com ou sem máscara), só dígitos. */
export function cnpjDoTexto(texto: string | null | undefined): string | null {
  if (!texto) return null;
  for (const m of texto.matchAll(/\d[\d./\-\s]{12,20}\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length === 14 && cnpjValido(d)) return d;
  }
  return null;
}

export const formatarCnpj = (d: string) => d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

const nomeCliente = (c: { razaoSocial: string; nomeFantasia: string | null }) => c.nomeFantasia || c.razaoSocial;

export async function verificarDuplicidade(dados: {
  telefone?: string | null;
  cnpj?: string | null;
  email?: string | null;
  excetoId?: string | null;
}): Promise<AvisoDuplicidade[]> {
  const avisos: AvisoDuplicidade[] = [];
  const exceto = dados.excetoId ?? undefined;

  const chave = dados.telefone ? chaveTelefone(dados.telefone) : null;
  if (chave && dados.telefone) {
    const telefone = normalizarTelefone(dados.telefone);
    const leads = await prisma.lead.findMany({
      where: { telefone: { endsWith: chave.slice(-8) }, ...(exceto ? { id: { not: exceto } } : {}) },
      select: { id: true, nome: true, telefone: true, status: true },
    });
    const outro = leads.find((l) => chaveTelefone(l.telefone) === chave);
    if (outro) {
      avisos.push({
        tipo: "lead_telefone",
        bloqueia: true,
        mensagem: `Já existe um lead com esse telefone: ${outro.nome} (${STATUS_ROTULO[outro.status]}).`,
        leadId: outro.id,
      });
    }

    const contato = await identificarContato(telefone);
    if (contato) {
      const cliente = await prisma.cliente.findUnique({ where: { id: contato.clienteId }, select: { id: true, razaoSocial: true, nomeFantasia: true, ativo: true } });
      if (cliente) {
        avisos.push({
          tipo: "contato_cliente",
          bloqueia: false,
          mensagem: `Esse número é do contato ${contato.nome} do ${cliente.ativo ? "cliente" : "ex-cliente"} ${nomeCliente(cliente)}.`,
          clienteId: cliente.id,
        });
      }
    }

    const conversa = await conversaPelaChave(telefone);
    if (conversa) {
      const [aberto, leadDaConversa, cliente] = await Promise.all([
        prisma.atendimento.findFirst({
          where: { conversaId: conversa.id, status: { not: "FINALIZADO" } },
          orderBy: { abertoEm: "desc" },
          include: { responsavel: { select: { nome: true } }, setor: { select: { nome: true } } },
        }),
        prisma.lead.findUnique({ where: { conversaId: conversa.id }, select: { id: true } }),
        conversa.clienteId && !contato
          ? prisma.cliente.findUnique({ where: { id: conversa.clienteId }, select: { razaoSocial: true, nomeFantasia: true } })
          : null,
      ]);
      const deOutroLead = leadDaConversa && leadDaConversa.id !== exceto;
      if (!deOutroLead && (aberto || cliente)) {
        const partes: string[] = [];
        if (cliente) partes.push(`a conversa está vinculada ao cliente ${nomeCliente(cliente)}`);
        if (aberto) {
          const quem = aberto.responsavel?.nome ? ` com ${aberto.responsavel.nome}` : aberto.setor?.nome ? ` no setor ${aberto.setor.nome}` : "";
          partes.push(`há um atendimento em andamento${quem}`);
        }
        avisos.push({
          tipo: "conversa",
          bloqueia: false,
          mensagem: `Já existe conversa no WhatsApp com esse número: ${partes.join(" e ")}.`,
          conversaId: conversa.id,
        });
      }
    }
  }

  const cnpj = dados.cnpj ? dados.cnpj.replace(/\D/g, "") : null;
  if (cnpj) {
    const [cliente, leads] = await Promise.all([
      prisma.cliente.findUnique({ where: { cnpj }, select: { id: true, razaoSocial: true, nomeFantasia: true, ativo: true } }),
      prisma.lead.findMany({
        where: { cnpj, ...(exceto ? { id: { not: exceto } } : {}) },
        select: { id: true, nome: true, status: true, motivoEncerramento: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    if (cliente) {
      avisos.push({
        tipo: "cliente_cnpj",
        bloqueia: false,
        mensagem: `O CNPJ ${formatarCnpj(cnpj)} já é ${cliente.ativo ? "cliente" : "ex-cliente"} da casa: ${nomeCliente(cliente)}.`,
        clienteId: cliente.id,
      });
    }
    const emTratamento = leads.find((l) => !ENCERRADO.has(l.status));
    const tratado = leads.find((l) => ENCERRADO.has(l.status));
    if (emTratamento) {
      avisos.push({
        tipo: "lead_cnpj",
        bloqueia: false,
        mensagem: `O CNPJ ${formatarCnpj(cnpj)} já está em tratamento no lead ${emTratamento.nome} (${STATUS_ROTULO[emTratamento.status]}).`,
        leadId: emTratamento.id,
      });
    } else if (tratado) {
      avisos.push({
        tipo: "lead_cnpj",
        bloqueia: false,
        mensagem: `O CNPJ ${formatarCnpj(cnpj)} já foi tratado no lead ${tratado.nome} (${STATUS_ROTULO[tratado.status]}${tratado.motivoEncerramento ? `: ${tratado.motivoEncerramento}` : ""}).`,
        leadId: tratado.id,
      });
    }
  }

  const email = dados.email?.trim().toLowerCase();
  if (email) {
    const outro = await prisma.lead.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, ...(exceto ? { id: { not: exceto } } : {}) },
      select: { id: true, nome: true, status: true },
    });
    if (outro) {
      avisos.push({
        tipo: "lead_email",
        bloqueia: false,
        mensagem: `O e-mail ${email} já está no lead ${outro.nome} (${STATUS_ROTULO[outro.status]}).`,
        leadId: outro.id,
      });
    }
  }

  return avisos;
}
