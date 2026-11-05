// Geração e envio do relatório de saúde fiscal ("aqui seu relatório de saúde
// fiscal") e da lista de pendências, por e-mail (Resend) e WhatsApp (provedor
// configurado: simulador ou Evolution). Mesmos canais dos protocolos de entrega.
import { randomBytes } from "node:crypto";

import { emailConfigurado, enviarEmail } from "../envio/email.js";
import { prisma } from "../prisma.js";
import { provedorWhatsApp } from "../whatsapp/provedor.js";
import { normalizarTelefone, telefoneValido } from "../whatsapp/telefone.js";
import { montarSaudeFiscal, paraCliente, pendenciasDoCliente, type Pendencia } from "./dados.js";

export type Canal = "email" | "whatsapp";

export interface ResultadoEnvio {
  canal: Canal;
  destino: string;
  nome: string;
  status: "enviado" | "falha";
  erro?: string;
  em: string;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const nomeMes = (mes: string) => {
  const [a, m] = mes.split("-").map(Number) as [number, number];
  return `${MESES[m - 1]} de ${a}`;
};

export function linkSaudeFiscal(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/saude-fiscal/${token}`;
}

const escapar = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0] ?? nome;

/** Contatos que recebem: ativos que recebem de todos os setores ou são o responsável legal. */
async function destinatarios(clienteId: string, contatoIds?: string[]) {
  const contatos = await prisma.contatoCliente.findMany({
    where: {
      clienteId,
      ativo: true,
      ...(contatoIds?.length ? { id: { in: contatoIds } } : { OR: [{ recebeTodos: true }, { responsavelLegal: true }] }),
    },
    select: { id: true, nome: true, email: true, celular: true },
    orderBy: { nome: "asc" },
  });
  return contatos;
}

interface Mensagem {
  assunto: string;
  texto: (nome: string) => string;
  html: (nome: string) => string;
}

async function disparar(clienteId: string, canais: Canal[], mensagem: Mensagem, contatoIds?: string[]) {
  const contatos = await destinatarios(clienteId, contatoIds);
  const resultados: ResultadoEnvio[] = [];
  const registrar = (r: Omit<ResultadoEnvio, "em">) => resultados.push({ ...r, em: new Date().toISOString() });
  for (const c of contatos) {
    if (canais.includes("email") && c.email) {
      try {
        if (!emailConfigurado()) throw new Error("Envio por e-mail não configurado no servidor (RESEND_API_KEY)");
        await enviarEmail({ para: c.email, assunto: mensagem.assunto, texto: mensagem.texto(c.nome), html: mensagem.html(c.nome) });
        registrar({ canal: "email", destino: c.email, nome: c.nome, status: "enviado" });
      } catch (error) {
        registrar({ canal: "email", destino: c.email, nome: c.nome, status: "falha", erro: error instanceof Error ? error.message : String(error) });
      }
    }
    if (canais.includes("whatsapp") && c.celular) {
      if (!telefoneValido(c.celular)) {
        registrar({ canal: "whatsapp", destino: c.celular, nome: c.nome, status: "falha", erro: "Celular inválido no cadastro" });
        continue;
      }
      const telefone = normalizarTelefone(c.celular);
      try {
        await provedorWhatsApp().enviarTexto(telefone, mensagem.texto(c.nome));
        registrar({ canal: "whatsapp", destino: telefone, nome: c.nome, status: "enviado" });
      } catch (error) {
        registrar({ canal: "whatsapp", destino: telefone, nome: c.nome, status: "falha", erro: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { contatos: contatos.length, resultados };
}

function moldura(conteudo: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;line-height:1.5">${conteudo}<p style="color:#6b7280;font-size:12px;margin-top:24px">Apta Contabilidade</p></div>`;
}

/** Gera o relatório do mês (números congelados) e, se pedido, envia aos contatos. */
export async function gerarRelatorio(opcoes: {
  clienteId: string;
  mes: string;
  usuarioId?: string | null;
  automatico?: boolean;
  enviar?: { canais: Canal[]; contatoIds?: string[] } | null;
}) {
  const dados = paraCliente(await montarSaudeFiscal(opcoes.clienteId, opcoes.mes));
  const relatorio = await prisma.relatorioSaudeFiscal.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      clienteId: opcoes.clienteId,
      mes: opcoes.mes,
      dados: dados as object,
      automatico: Boolean(opcoes.automatico),
      usuarioId: opcoes.usuarioId ?? null,
    },
  });
  if (!opcoes.enviar) return { relatorio, contatos: 0, resultados: [] as ResultadoEnvio[] };

  const link = linkSaudeFiscal(relatorio.token);
  const empresa = dados.empresa.nomeFantasia || dados.empresa.razaoSocial;
  const periodo = nomeMes(opcoes.mes);
  const { contatos, resultados } = await disparar(
    opcoes.clienteId,
    opcoes.enviar.canais,
    {
      assunto: `Relatório de saúde fiscal · ${empresa} · ${periodo}`,
      texto: (nome) =>
        `Olá, ${primeiroNome(nome)}! Aqui está o seu relatório de saúde fiscal de ${periodo} da ${empresa}: compras, vendas, serviços, guias e pendências do mês.\n\n${link}\n\nQualquer dúvida, é só responder esta mensagem.\nApta Contabilidade`,
      html: (nome) =>
        moldura(
          `<p>Olá, ${escapar(primeiroNome(nome))}!</p><p>Aqui está o seu <strong>relatório de saúde fiscal de ${escapar(periodo)}</strong> da ${escapar(empresa)}: compras, vendas, serviços, guias e pendências do mês.</p><p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Ver meu relatório</a></p><p style="font-size:13px;color:#6b7280">Se o botão não abrir, copie o endereço: ${link}</p>`,
        ),
    },
    opcoes.enviar.contatoIds,
  );
  const atualizado = await prisma.relatorioSaudeFiscal.update({
    where: { id: relatorio.id },
    data: { envios: resultados as unknown as object },
  });
  return { relatorio: atualizado, contatos, resultados };
}

/** Envia a lista de pendências do cliente (só as que valem para ele). */
export async function enviarPendencias(clienteId: string, canais: Canal[], contatoIds?: string[]) {
  const [cliente, todas] = await Promise.all([
    prisma.cliente.findUniqueOrThrow({ where: { id: clienteId }, select: { razaoSocial: true, nomeFantasia: true } }),
    pendenciasDoCliente(clienteId),
  ]);
  const pendencias = todas.filter((p) => !p.interna);
  if (pendencias.length === 0) throw new Error("Não há pendências do cliente para enviar");
  const empresa = cliente.nomeFantasia || cliente.razaoSocial;
  const linha = (p: Pendencia, i: number) => `${i + 1}. ${p.titulo}${p.detalhe ? ` (${p.detalhe})` : ""}`;
  return disparar(
    clienteId,
    canais,
    {
      assunto: `Pendências com a Apta Contabilidade · ${empresa}`,
      texto: (nome) =>
        `Olá, ${primeiroNome(nome)}! Estas são as pendências da ${empresa} com a Apta Contabilidade hoje:\n\n${pendencias
          .map(linha)
          .join("\n")}\n\nQualquer dúvida, é só responder esta mensagem.\nApta Contabilidade`,
      html: (nome) =>
        moldura(
          `<p>Olá, ${escapar(primeiroNome(nome))}!</p><p>Estas são as pendências da ${escapar(empresa)} com a Apta Contabilidade hoje:</p><ol>${pendencias
            .map((p) => `<li><strong>${escapar(p.titulo)}</strong>${p.detalhe ? `<br><span style="color:#6b7280">${escapar(p.detalhe)}</span>` : ""}</li>`)
            .join("")}</ol><p>Qualquer dúvida, é só responder este e-mail.</p>`,
        ),
    },
    contatoIds,
  );
}

// ------------------------------------------------------------- envio em lote

export interface EstadoLote {
  situacao: "parado" | "andamento" | "concluido";
  mes: string | null;
  total: number;
  feitos: number;
  enviados: number;
  semContato: number;
  falhas: string[];
  iniciadoEm: string | null;
  concluidoEm: string | null;
}
let estadoLote: EstadoLote = {
  situacao: "parado",
  mes: null,
  total: 0,
  feitos: 0,
  enviados: 0,
  semContato: 0,
  falhas: [],
  iniciadoEm: null,
  concluidoEm: null,
};
export const estadoEnvioLote = () => estadoLote;

/** Clientes ativos que estão (ativos) na SIEG -- os que têm notas para o relatório. */
export async function clientesDoLote() {
  const [clientes, empresas] = await Promise.all([
    prisma.cliente.findMany({ where: { ativo: true }, select: { id: true, cnpj: true, razaoSocial: true }, orderBy: { razaoSocial: "asc" } }),
    prisma.siegEmpresa.findMany({ where: { ativo: true, deletado: false }, select: { documento: true } }),
  ]);
  const naSieg = new Set(empresas.map((e) => e.documento));
  return clientes.filter((c) => naSieg.has(c.cnpj.replace(/\D/g, "")));
}

export async function enviarLote(mes: string, canais: Canal[], opcoes: { automatico: boolean; usuarioId?: string | null }) {
  if (estadoLote.situacao === "andamento") return estadoLote;
  const clientes = await clientesDoLote();
  estadoLote = {
    situacao: "andamento",
    mes,
    total: clientes.length,
    feitos: 0,
    enviados: 0,
    semContato: 0,
    falhas: [],
    iniciadoEm: new Date().toISOString(),
    concluidoEm: null,
  };
  for (const c of clientes) {
    try {
      const r = await gerarRelatorio({ clienteId: c.id, mes, automatico: opcoes.automatico, usuarioId: opcoes.usuarioId, enviar: { canais } });
      if (r.contatos === 0 || r.resultados.length === 0) estadoLote.semContato++;
      else if (r.resultados.some((x) => x.status === "enviado")) estadoLote.enviados++;
      else estadoLote.falhas.push(`${c.razaoSocial}: ${r.resultados[0]?.erro ?? "falha no envio"}`);
    } catch (error) {
      estadoLote.falhas.push(`${c.razaoSocial}: ${error instanceof Error ? error.message : String(error)}`);
    }
    estadoLote.feitos++;
  }
  estadoLote = { ...estadoLote, falhas: estadoLote.falhas.slice(-50), situacao: "concluido", concluidoEm: new Date().toISOString() };
  return estadoLote;
}
