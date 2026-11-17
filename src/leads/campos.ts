// Campos do "formulário" do lead. As mesmas chaves servem para o formulário
// do anúncio (Meta Ads, colado no cadastro) e para o que o assistente coleta
// na conversa (ferramenta salvar_perfil).
import { normalizarTelefone } from "../whatsapp/telefone.js";

export interface CampoPerfil {
  chave: string;
  rotulo: string;
  /** Como o assistente pergunta, se a resposta ainda não veio. */
  pergunta: string;
  obrigatorio: boolean;
  /** Pedaços do rótulo que o reconhecem na mensagem colada (sem acento). */
  reconhece: string[];
}

export const CAMPOS_PERFIL: CampoPerfil[] = [
  {
    chave: "possuiCnpj",
    rotulo: "Possui empresa aberta (CNPJ)?",
    pergunta: "Já tem empresa aberta (CNPJ)?",
    obrigatorio: true,
    reconhece: ["possui empresa", "cnpj", "tem empresa"],
  },
  {
    chave: "situacao",
    rotulo: "Situação atual",
    pergunta: "Qual a situação hoje (vai abrir empresa, já tem contador, está insatisfeito...)?",
    obrigatorio: true,
    reconhece: ["situacao"],
  },
  {
    chave: "principalDor",
    rotulo: "Principal dor",
    pergunta: "Qual o principal problema que quer resolver?",
    obrigatorio: true,
    reconhece: ["dor", "problema"],
  },
  {
    chave: "faturamento",
    rotulo: "Faixa de faturamento",
    pergunta: "Qual a faixa de faturamento mensal?",
    obrigatorio: true,
    reconhece: ["faturamento"],
  },
  {
    chave: "prazo",
    rotulo: "Prazo para resolver",
    pergunta: "Para quando precisa resolver?",
    obrigatorio: true,
    reconhece: ["prazo"],
  },
  {
    chave: "interesseEconomia",
    rotulo: "Interesse em economia tributária",
    pergunta: "Tem interesse em entender como pagar menos imposto e organizar as contas?",
    obrigatorio: false,
    reconhece: ["economia", "tributari"],
  },
  {
    chave: "necessidade",
    rotulo: "Necessidade informada",
    pergunta: "Em poucas palavras, o que precisa da contabilidade?",
    obrigatorio: false,
    reconhece: ["necessidade"],
  },
  {
    chave: "ramo",
    rotulo: "Ramo de atividade",
    pergunta: "Qual o ramo/atividade da empresa?",
    obrigatorio: false,
    reconhece: ["ramo", "atividade", "segmento"],
  },
  {
    chave: "cidade",
    rotulo: "Cidade",
    pergunta: "De qual cidade?",
    obrigatorio: false,
    reconhece: ["cidade", "localizacao"],
  },
];

export type PerfilLead = Record<string, string>;

const semAcento = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function perfilDe(valor: unknown): PerfilLead {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return {};
  const saida: PerfilLead = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) saida[k] = v.trim();
    else if (typeof v === "number" || typeof v === "boolean") saida[k] = String(v);
  }
  return saida;
}

export function camposFaltando(perfil: PerfilLead): CampoPerfil[] {
  return CAMPOS_PERFIL.filter((c) => c.obrigatorio && !perfil[c.chave]);
}

export function perfilCompleto(perfil: PerfilLead): boolean {
  return camposFaltando(perfil).length === 0;
}

export function rotuloDoCampo(chave: string): string {
  return CAMPOS_PERFIL.find((c) => c.chave === chave)?.rotulo ?? chave;
}

function chaveDoRotulo(rotulo: string): string {
  const r = semAcento(rotulo);
  const campo = CAMPOS_PERFIL.find((c) => c.reconhece.some((p) => r.includes(p)));
  return campo?.chave ?? rotulo.replace(/[?:]+$/, "").trim();
}

export interface LeadInterpretado {
  nome: string | null;
  telefone: string | null;
  email: string | null;
  origem: string | null;
  qualificacao: string | null;
  perfil: PerfilLead;
}

// Limpa a marcação do WhatsApp: *negrito*, _itálico_, "\" no fim da linha,
// emojis no começo.
function limpar(linha: string): string {
  return linha
    .replace(/\\\s*$/, "")
    .replace(/[*_~]/g, "")
    .replace(/^[^\p{L}\p{N}+(]+/u, "")
    .trim();
}

const ehRotulo = (l: string) => /^[^:]{2,80}:/.test(l) || /^[^:]{2,80}\?$/.test(l) || /^lead\b/i.test(l);

/**
 * Lê a mensagem de "Novo Lead Recebido" (formato do anúncio) e devolve os
 * campos. Aceita "Rótulo: valor" na mesma linha ou o valor na linha seguinte.
 */
export function interpretarMensagemLead(texto: string): LeadInterpretado {
  const saida: LeadInterpretado = { nome: null, telefone: null, email: null, origem: null, qualificacao: null, perfil: {} };
  const linhas = texto.split(/\r?\n/).map(limpar);

  const titulo = linhas.find((l) => /lead/i.test(l) && /\(([^)]+)\)/.test(l));
  if (titulo) saida.origem = titulo.match(/\(([^)]+)\)/)![1].trim();

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha) continue;
    // "Rótulo: valor" ou pergunta sem dois-pontos ("Possui CNPJ?") com a
    // resposta na linha de baixo.
    const m = linha.match(/^([^:]{2,80}?):\s*(.*)$/) ?? linha.match(/^([^:]{2,80}\?)()$/);
    if (!m) {
      // "🔥 Lead altamente qualificado — motivo"
      if (/^lead\b/i.test(linha) && !saida.qualificacao && !/recebido/i.test(linha)) {
        saida.qualificacao = linha.replace(/\s+/g, " ");
      }
      continue;
    }
    const rotulo = m[1].trim();
    let valor = m[2].trim();
    if (!valor) {
      // valor na(s) linha(s) seguinte(s), até a próxima linha vazia
      const partes: string[] = [];
      while (i + 1 < linhas.length && linhas[i + 1] && !ehRotulo(linhas[i + 1])) {
        partes.push(linhas[++i]);
      }
      valor = partes.join(" ").trim();
    }
    valor = valor.replace(/\.$/, "").trim();
    if (!valor) continue;
    const r = semAcento(rotulo);
    if (/^nome/.test(r)) saida.nome = valor;
    else if (/telefone|celular|whats/.test(r)) saida.telefone = normalizarTelefone(valor);
    else if (/e-?mail/.test(r)) saida.email = valor.toLowerCase();
    else if (/origem|fonte|campanha/.test(r)) saida.origem = valor;
    else saida.perfil[chaveDoRotulo(rotulo)] = valor;
  }
  return saida;
}

export function primeiroNome(nome: string): string {
  const p = nome.trim().split(/\s+/)[0] ?? nome;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
