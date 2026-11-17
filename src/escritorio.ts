// Dados do escritório em memória (lidos uma vez e atualizados ao salvar), para
// as mensagens que montam texto sem esperar o banco.
import { prismaBase } from "./prisma.js";

export interface DadosEscritorio {
  nome: string;
  razaoSocial: string | null;
  cnpj: string | null;
  crc: string | null;
  responsavelTecnico: string | null;
  email: string | null;
  telefone: string | null;
  whatsapp: string | null;
  site: string | null;
  endereco: string | null;
  cidade: string;
  uf: string;
  assinaturaMensagens: string | null;
}

const PADRAO: DadosEscritorio = {
  nome: "Apta Contabilidade",
  razaoSocial: null,
  cnpj: null,
  crc: null,
  responsavelTecnico: null,
  email: null,
  telefone: null,
  whatsapp: null,
  site: null,
  endereco: null,
  cidade: process.env.ESCRITORIO_CIDADE ?? "Fortaleza",
  uf: process.env.ESCRITORIO_UF ?? "CE",
  assinaturaMensagens: null,
};

let atual: DadosEscritorio = PADRAO;

/** Dados atuais (síncrono). */
export const escritorio = (): DadosEscritorio => atual;

/** Linha de assinatura das mensagens ao cliente. */
export const assinatura = (): string => atual.assinaturaMensagens?.trim() || atual.nome;

export async function carregarEscritorio(): Promise<DadosEscritorio> {
  try {
    const c = await prismaBase.configuracaoEscritorio.findUnique({ where: { id: 1 } });
    if (c) {
      const { id: _id, updatedAt: _u, ...dados } = c;
      atual = { ...PADRAO, ...dados };
    }
  } catch (error) {
    console.error("[escritorio] não carregou os dados; usando o padrão", error);
  }
  return atual;
}
