// Empresas/certificados da conta SIEG (GET /api/v1/listar), gravados em
// `sieg_empresas`. A tela lê do banco; a SIEG só é consultada pela busca
// (agendada ou pelo botão "Atualizar do SIEG").
//
// Comportamento REAL da API (diferente da documentação, visto em produção
// em 04/11/2026):
//  - `active=false` NÃO traz "ativos e inativos": traz só os inativos/
//    excluídos. Os certificados em uso vêm com `active=true`. Por isso
//    buscamos as duas listas: primeiro as ativas, depois as inativas.
//  - Depois da última página o SIEG não devolve lista vazia: responde 404
//    "Nenhum certificado encontrado" ou até 500 "Erro interno". Os dois, a
//    partir da 2ª página, são tratados como fim da lista.
import { prisma } from "../prisma.js";
import { chamarSieg, ErroSieg } from "./cliente.js";

const MAX_PAGINAS = 100;

export interface EmpresaSieg {
  id: string;
  nome: string;
  documento: string; // só dígitos
  ufCertificado: number | null;
  certificadoExpiraEm: string | null;
  consultaNoturna: boolean;
  ativo: boolean;
  deletado: boolean;
  /** GET /api/v1/status (preenchido pela busca agendada). */
  statusSieg?: string | null;
  ultimaConsultaSieg?: string | null;
}

export interface EstadoSincronizacao {
  situacao: "nunca" | "andamento" | "concluida" | "erro";
  iniciadaEm: string | null;
  concluidaEm: string | null;
  paginasLidas: number;
  erro: string | null;
  /** Avisos que não impedem o uso da lista (ex.: inativas não carregaram). */
  avisos: string[];
}

let estado: EstadoSincronizacao = {
  situacao: "nunca",
  iniciadaEm: null,
  concluidaEm: null,
  paginasLidas: 0,
  erro: null,
  avisos: [],
};

export function estadoEmpresasSieg(): EstadoSincronizacao {
  return estado;
}

/** Empresas gravadas no banco (o que a tela mostra). */
export async function empresasSiegGravadas(): Promise<EmpresaSieg[]> {
  const linhas = await prisma.siegEmpresa.findMany({ orderBy: { nome: "asc" } });
  return linhas.map((l) => ({
    id: l.id,
    nome: l.nome,
    documento: l.documento,
    ufCertificado: l.ufCertificado,
    certificadoExpiraEm: l.certificadoExpiraEm?.toISOString() ?? null,
    consultaNoturna: l.consultaNoturna,
    ativo: l.ativo,
    deletado: l.deletado,
    statusSieg: l.statusSieg,
    ultimaConsultaSieg: l.ultimaConsultaSieg?.toISOString() ?? null,
  }));
}

interface ItemSieg {
  Id?: string;
  Nome?: string;
  CnpjCpf?: string;
  UfCertificado?: number;
  DataExpira?: string;
  ConsultaNoturna?: boolean;
  Ativo?: boolean;
  Deletado?: boolean;
}

function normalizar(item: ItemSieg): EmpresaSieg {
  const documento = String(item.CnpjCpf ?? "").replace(/\D/g, "");
  return {
    id: String(item.Id ?? "") || documento,
    nome: String(item.Nome ?? "").trim(),
    documento,
    ufCertificado: typeof item.UfCertificado === "number" ? item.UfCertificado : null,
    certificadoExpiraEm: item.DataExpira ?? null,
    consultaNoturna: Boolean(item.ConsultaNoturna),
    ativo: Boolean(item.Ativo),
    deletado: Boolean(item.Deletado),
  };
}

async function buscarPagina(ativos: boolean, pagina: number): Promise<ItemSieg[]> {
  try {
    const corpo = await chamarSieg<{ Data?: ItemSieg[] | null } | ItemSieg[]>("/api/v1/listar", {
      query: { active: ativos, pagina },
    });
    return Array.isArray(corpo) ? corpo : (corpo?.Data ?? []);
  } catch (error) {
    // Página depois da última: o SIEG responde 404 "Nenhum certificado".
    if (error instanceof ErroSieg && error.status === 404 && /nenhum certificado/i.test(error.message)) return [];
    throw error;
  }
}

async function lerLista(
  ativos: boolean,
  aoLer: (pagina: number) => void,
): Promise<{ empresas: EmpresaSieg[]; fimPresumido: boolean }> {
  const coletadas = new Map<string, EmpresaSieg>();
  let tentativasErro = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    let itens: ItemSieg[];
    try {
      itens = await buscarPagina(ativos, pagina);
      tentativasErro = 0;
    } catch (error) {
      if (error instanceof ErroSieg && (error.status ?? 0) >= 500 && tentativasErro < 1) {
        tentativasErro++;
        await new Promise((r) => setTimeout(r, 5_000));
        pagina--;
        continue;
      }
      if (error instanceof ErroSieg && error.status !== null && pagina > 0 && coletadas.size > 0) {
        return { empresas: [...coletadas.values()], fimPresumido: true };
      }
      throw error;
    }
    if (itens.length === 0) break;
    const antes = coletadas.size;
    for (const item of itens) {
      const e = normalizar(item);
      coletadas.set(e.id, e);
    }
    aoLer(pagina + 1);
    if (coletadas.size === antes) break; // a API ignorou a paginação
  }
  return { empresas: [...coletadas.values()], fimPresumido: false };
}

async function gravar(empresas: EmpresaSieg[]) {
  for (const e of empresas) {
    const dados = {
      documento: e.documento,
      nome: e.nome,
      ufCertificado: e.ufCertificado,
      certificadoExpiraEm: e.certificadoExpiraEm ? new Date(e.certificadoExpiraEm) : null,
      consultaNoturna: e.consultaNoturna,
      ativo: e.ativo,
      deletado: e.deletado,
    };
    await prisma.siegEmpresa.upsert({ where: { id: e.id }, create: { id: e.id, ...dados }, update: dados });
  }
}

/** Busca as duas listas na SIEG e grava no banco. Usada pelo botão e pela busca agendada. */
export async function sincronizarEmpresas(): Promise<void> {
  let paginas = 0;
  const avisos: string[] = [];
  try {
    const ativas = await lerLista(true, (p) => {
      paginas = p;
      estado = { ...estado, paginasLidas: paginas };
    });
    if (ativas.fimPresumido)
      avisos.push(
        `A SIEG respondeu erro ao pedir a página ${paginas + 1} das empresas ativas; tratamos como fim da lista (${ativas.empresas.length} empresas). Se faltar alguma, clique em “Atualizar do SIEG”.`,
      );

    let inativas: EmpresaSieg[] = [];
    try {
      inativas = (
        await lerLista(false, (p) => {
          estado = { ...estado, paginasLidas: paginas + p };
        })
      ).empresas;
    } catch (error) {
      avisos.push(
        `As empresas inativas/excluídas não carregaram (${error instanceof Error ? error.message : String(error)}). As ativas estão completas.`,
      );
    }

    const idsAtivos = new Set(ativas.empresas.map((e) => e.id));
    const todas = [...ativas.empresas, ...inativas.filter((e) => !idsAtivos.has(e.id))];
    await gravar(todas);
    // Empresa que sumiu das duas listas da SIEG: marca como excluída (não apaga o histórico).
    if (todas.length > 0) {
      await prisma.siegEmpresa.updateMany({
        where: { id: { notIn: todas.map((e) => e.id) } },
        data: { ativo: false, deletado: true },
      });
    }
    estado = { ...estado, situacao: "concluida", concluidaEm: new Date().toISOString(), avisos };
  } catch (error) {
    estado = {
      ...estado,
      situacao: "erro",
      erro: error instanceof Error ? error.message : String(error),
      avisos,
    };
    throw error;
  }
}

/** Dispara a busca em segundo plano (ignora se já houver uma em andamento). */
export function iniciarSincronizacaoEmpresas(): EstadoSincronizacao {
  if (estado.situacao === "andamento") return estado;
  estado = {
    situacao: "andamento",
    iniciadaEm: new Date().toISOString(),
    concluidaEm: null,
    paginasLidas: 0,
    erro: null,
    avisos: [],
  };
  void sincronizarEmpresas().catch((erro) => console.error("[sieg] falha ao buscar empresas", erro));
  return estado;
}
