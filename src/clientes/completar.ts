// Preenchimento automático do cadastro dos clientes, sem botão: roda quando o
// servidor sobe, quando entra um cliente novo e toda manhã (depois da captura
// noturna da SIEG). Só preenche campo VAZIO -- nunca sobrescreve o que a equipe
// digitou -- e só quando a informação existe.
//
// Fontes:
//  - Receita (BrasilAPI): CNAE, abertura, situação, endereço, nome fantasia e
//    o sócio-administrador como responsável legal (contato).
//  - SIEG (contagens): que notas a empresa emite.
//  - XMLs guardados: inscrição estadual (NF-e) e municipal (NFS-e).
//  - CNAE + notas emitidas: atividade (comércio, serviços, indústria).
// O regime tributário fica de fora: escolher o regime aplica as obrigações do
// cliente, e isso é decisão da equipe.
import { gunzipSync } from "node:zlib";

import { prisma } from "../prisma.js";
import { inscricoesDoXml } from "../sieg/arquivos.js";
import { consultarReceita, ErroReceita } from "./receita.js";

const NOVA_CONSULTA_RECEITA_MS = 30 * 86_400_000;
const PAUSA_RECEITA_MS = 1_500; // BrasilAPI é pública: sem rajadas
const HORA_ROTINA = 8; // depois que a captura noturna da SIEG para

type Atividade = "servicos" | "comercio" | "industria";
type NotaEmitida = "nfse" | "nfe" | "nfce" | "cte";

export interface EstadoPreenchimento {
  situacao: "parado" | "andamento" | "concluido";
  total: number;
  feitos: number;
  atualizados: number;
  erros: string[];
  iniciadoEm: string | null;
  concluidoEm: string | null;
}
let estado: EstadoPreenchimento = {
  situacao: "parado",
  total: 0,
  feitos: 0,
  atualizados: 0,
  erros: [],
  iniciadoEm: null,
  concluidoEm: null,
};
export const estadoPreenchimento = () => estado;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vazio = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Atividade pela divisão do CNAE (dois primeiros dígitos). */
function atividadeDoCnae(cnae: string | null): Atividade | null {
  const divisao = Number(cnae?.slice(0, 2));
  if (!divisao) return null;
  if (divisao >= 5 && divisao <= 33) return "industria";
  if (divisao >= 45 && divisao <= 47) return "comercio";
  if (divisao >= 35) return "servicos";
  return null; // agropecuária: a equipe decide
}

/** Tipos de nota que a empresa emitiu em algum mês contado na SIEG. */
async function notasEmitidasPelaSieg(documento: string): Promise<NotaEmitida[]> {
  const contagens = await prisma.siegContagem.findMany({ where: { documento, papel: "emitente" } });
  const tipos: NotaEmitida[] = [];
  for (const t of ["nfse", "nfe", "nfce", "cte"] as const) if (contagens.some((c) => c[t] > 0)) tipos.push(t);
  return tipos;
}

/** IE e IM a partir dos XMLs guardados em que a empresa aparece. */
async function inscricoesPelosXmls(documento: string, precisaIe: boolean, precisaIm: boolean) {
  const achadas: { ie: string | null; im: string | null } = { ie: null, im: null };
  const buscar = async (tipos: string[]) =>
    prisma.siegNota.findMany({
      where: { documentoEmpresa: documento, tipo: { in: tipos }, xml: { not: null } },
      select: { xml: true },
      orderBy: { emissao: "desc" },
      take: 20,
    });
  if (precisaIe) {
    for (const n of await buscar(["nfe", "nfce", "cte"])) {
      achadas.ie = inscricoesDoXml(gunzipSync(n.xml!).toString("utf8"), documento).ie;
      if (achadas.ie) break;
    }
  }
  if (precisaIm) {
    for (const n of await buscar(["nfse"])) {
      achadas.im = inscricoesDoXml(gunzipSync(n.xml!).toString("utf8"), documento).im;
      if (achadas.im) break;
    }
  }
  return achadas;
}

/**
 * Completa um cliente. Devolve true se mudou algo. `receita=false` usa só os
 * dados locais (SIEG/XMLs), sem consultar a internet.
 */
export async function completarCliente(clienteId: string, receita = true): Promise<boolean> {
  const c = await prisma.cliente.findUnique({
    where: { id: clienteId },
    include: { contatos: { select: { nome: true, responsavelLegal: true } } },
  });
  if (!c) return false;
  const documento = c.cnpj.replace(/\D/g, "");
  const dados: Record<string, unknown> = {};
  const temResponsavel = c.contatos.some((x) => x.responsavelLegal);

  // 1. Receita -- só para CNPJ, só se faltar algo que ela tem, no máximo 1x por mês.
  const faltaReceita =
    vazio(c.cnaePrincipal) || vazio(c.dataAbertura) || vazio(c.endereco) || vazio(c.cidade) || !temResponsavel;
  const consultadaHaPouco =
    c.receitaConsultadaEm && Date.now() - c.receitaConsultadaEm.getTime() < NOVA_CONSULTA_RECEITA_MS;
  let cnae = c.cnaePrincipal;
  if (receita && documento.length === 14 && faltaReceita && !consultadaHaPouco) {
    dados["receitaConsultadaEm"] = new Date();
    try {
      const r = await consultarReceita(documento);
      if (vazio(c.nomeFantasia) && r.nomeFantasia) dados["nomeFantasia"] = r.nomeFantasia;
      if (vazio(c.situacaoCadastral) && r.situacaoCadastral) dados["situacaoCadastral"] = r.situacaoCadastral;
      if (vazio(c.dataAbertura) && r.dataAbertura) dados["dataAbertura"] = new Date(`${r.dataAbertura}T00:00:00.000Z`);
      if (vazio(c.cnaePrincipal) && r.cnaePrincipal) {
        dados["cnaePrincipal"] = r.cnaePrincipal;
        dados["cnaeDescricao"] = r.cnaeDescricao;
        cnae = r.cnaePrincipal;
      }
      if (vazio(c.cnaesSecundarios) && r.cnaesSecundarios.length) dados["cnaesSecundarios"] = r.cnaesSecundarios;
      if (vazio(c.cep) && r.cep) dados["cep"] = r.cep;
      if (vazio(c.endereco) && r.endereco) dados["endereco"] = r.endereco;
      if (vazio(c.cidade) && r.cidade) dados["cidade"] = r.cidade;
      if (vazio(c.uf) && r.uf) dados["uf"] = r.uf;
      if (!temResponsavel) {
        const nomes = new Set(c.contatos.map((x) => x.nome.toLowerCase()));
        // Sócio-administrador; sem ele, o titular/empresário (empresa individual) ou o presidente.
        const qualifica = (s: { cargo: string | null; responsavelLegal: boolean }) =>
          s.responsavelLegal || /titular|empres[aá]rio|presidente/i.test(s.cargo ?? "");
        const admins = r.socios.filter((s) => qualifica(s) && !nomes.has(s.nome.toLowerCase())).slice(0, 2);
        for (const s of admins) {
          await prisma.contatoCliente.create({
            data: { clienteId, nome: s.nome, cargo: s.cargo, responsavelLegal: true },
          });
        }
      }
    } catch (error) {
      // CNPJ não encontrado: marca como consultado e segue. Receita fora do ar: tenta na próxima.
      if (!(error instanceof ErroReceita && error.status === 404)) delete dados["receitaConsultadaEm"];
      if (!(error instanceof ErroReceita)) throw error;
    }
  }

  // 2. SIEG: que notas emite.
  let notas = c.notasEmitidas as NotaEmitida[];
  if (vazio(c.notasEmitidas)) {
    const daSieg = await notasEmitidasPelaSieg(documento);
    if (daSieg.length) {
      dados["notasEmitidas"] = daSieg;
      notas = daSieg;
    }
  }

  // 3. Atividade: CNAE + o que emite (NFS-e = serviços; NF-e/NFC-e = comércio).
  if (vazio(c.atividades)) {
    const atividades = new Set<Atividade>();
    const pelo = atividadeDoCnae(cnae);
    if (pelo) atividades.add(pelo);
    if (notas.includes("nfse")) atividades.add("servicos");
    if ((notas.includes("nfe") || notas.includes("nfce")) && !atividades.has("industria")) atividades.add("comercio");
    if (atividades.size) dados["atividades"] = [...atividades];
  }

  // 4. Inscrições pelos XMLs guardados.
  const precisaIe = vazio(c.inscricaoEstadual);
  const precisaIm = vazio(c.inscricaoMunicipal);
  if (precisaIe || precisaIm) {
    const { ie, im } = await inscricoesPelosXmls(documento, precisaIe, precisaIm);
    if (ie) dados["inscricaoEstadual"] = ie;
    if (im) dados["inscricaoMunicipal"] = im;
  }

  const mudou = Object.keys(dados).some((k) => k !== "receitaConsultadaEm");
  if (Object.keys(dados).length) await prisma.cliente.update({ where: { id: clienteId }, data: dados });
  return mudou;
}

/** Completa todos os clientes ativos (em segundo plano, um por vez). */
export async function completarTodos(): Promise<EstadoPreenchimento> {
  if (estado.situacao === "andamento") return estado;
  const clientes = await prisma.cliente.findMany({ where: { ativo: true }, select: { id: true, razaoSocial: true } });
  estado = {
    situacao: "andamento",
    total: clientes.length,
    feitos: 0,
    atualizados: 0,
    erros: [],
    iniciadoEm: new Date().toISOString(),
    concluidoEm: null,
  };
  for (const c of clientes) {
    const antes = Date.now();
    try {
      if (await completarCliente(c.id)) estado.atualizados++;
    } catch (error) {
      estado.erros.push(`${c.razaoSocial}: ${error instanceof Error ? error.message : String(error)}`);
    }
    estado.feitos++;
    // Só espera se houve consulta à Receita (passou do tempo de uma consulta local).
    if (Date.now() - antes > 200) await esperar(PAUSA_RECEITA_MS);
  }
  estado = { ...estado, erros: estado.erros.slice(-30), situacao: "concluido", concluidoEm: new Date().toISOString() };
  console.log(`[clientes] cadastros completados: ${estado.atualizados} de ${estado.total} atualizados`);
  return estado;
}

/** Dispara o preenchimento de um cliente recém-criado, sem segurar a resposta. */
export function completarEmSegundoPlano(clienteId: string): void {
  void completarCliente(clienteId).catch((e) => console.error("[clientes] falha ao completar cadastro", e));
}

export function agendarPreenchimentoClientes(): void {
  const rodar = () => void completarTodos().catch((e) => console.error("[clientes] falha ao completar cadastros", e));
  // Ao subir (dá tempo do resto do servidor iniciar) e toda manhã.
  setTimeout(rodar, 2 * 60_000).unref();
  let ultimoDia = "";
  setInterval(() => {
    const agora = new Date();
    const hora = Number(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));
    const dia = agora.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    if (hora === HORA_ROTINA && dia !== ultimoDia) {
      ultimoDia = dia;
      rodar();
    }
  }, 10 * 60_000).unref();
}
