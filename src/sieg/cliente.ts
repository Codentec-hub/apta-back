// Cliente HTTP único para a API da SIEG. Toda chamada passa por aqui para
// garantir três coisas:
//
// 1. SOMENTE LEITURA: só as rotas da lista abaixo podem ser chamadas. Enviar
//    XML, manifestar nota, cadastrar/editar/habilitar/desabilitar/deletar
//    certificado etc. ficam bloqueados no código (regra combinada: a SIEG
//    nunca é alterada pelo sistema).
// 2. LIMITE DE REQUISIÇÕES: cada rota tem o limite da documentação (contar
//    5/min, baixar em lote 2/min, baixar uma nota 20/min...). As chamadas
//    esperam a vez numa fila por rota e, se mesmo assim vier HTTP 429, tentam
//    de novo com espera crescente (exponential backoff), como a SIEG pede.
// 3. REGISTRO: cada chamada fica em `sieg_chamadas` (rota, status, tempo,
//    erro) para o painel de saúde da integração.
import { prisma } from "../prisma.js";
import { obterTokenSistema } from "./auth.js";
import { obterTokenOAuth } from "./oauth.js";

const BASE = "https://api.sieg.com";

/** Rotas de leitura permitidas e o limite de requisições por minuto de cada uma. */
const ROTAS_PERMITIDAS: Record<string, { metodo: "GET" | "POST"; porMinuto: number }> = {
  "/api/v1/listar": { metodo: "GET", porMinuto: 10 },
  "/api/v1/status": { metodo: "GET", porMinuto: 10 },
  "/api/v1/contar-xmls": { metodo: "POST", porMinuto: 5 },
  "/api/v1/baixar-xmls": { metodo: "POST", porMinuto: 2 },
  "/api/v1/baixar-xml": { metodo: "POST", porMinuto: 20 },
  "/api/v1/baixar-eventos": { metodo: "POST", porMinuto: 5 },
  "/api/v1/relatorios-pre-configurados": { metodo: "POST", porMinuto: 2 },
  "/api/v1/gerarDanfeViaXml": { metodo: "POST", porMinuto: 10 },
};

export class ErroSieg extends Error {
  constructor(
    mensagem: string,
    readonly status: number | null,
    readonly corpo: unknown = null,
  ) {
    super(mensagem);
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fila por rota: guarda o horário das últimas chamadas e faz a próxima
// esperar até caber no limite por minuto.
const historico = new Map<string, number[]>();
const filas = new Map<string, Promise<void>>();

async function aguardarVez(rota: string, porMinuto: number): Promise<void> {
  const anterior = filas.get(rota) ?? Promise.resolve();
  let liberar!: () => void;
  const minha = new Promise<void>((r) => (liberar = r));
  filas.set(
    rota,
    anterior.then(() => minha),
  );
  await anterior;
  try {
    const agora = Date.now();
    const janela = (historico.get(rota) ?? []).filter((t) => agora - t < 60_000);
    if (janela.length >= porMinuto) {
      const espera = 60_000 - (agora - janela[0]!) + 250;
      await esperar(espera);
    }
    const depois = Date.now();
    historico.set(rota, [...janela.filter((t) => depois - t < 60_000), depois]);
  } finally {
    liberar();
  }
}

async function registrar(rota: string, status: number | null, inicio: number, erro: string | null) {
  try {
    await prisma.siegChamada.create({
      data: { rota, status, duracaoMs: Date.now() - inicio, erro: erro ? erro.slice(0, 500) : null },
    });
  } catch {
    // O registro é só para o painel; nunca derruba a chamada.
  }
}

/** Mensagem de erro que a SIEG mandou, em qualquer um dos formatos de envelope dela. */
export function mensagemSieg(corpo: unknown): string | null {
  if (!corpo || typeof corpo !== "object") return typeof corpo === "string" && corpo ? corpo.slice(0, 300) : null;
  const c = corpo as Record<string, unknown>;
  if (typeof c["ErrorMessage"] === "string" && c["ErrorMessage"]) return c["ErrorMessage"] as string;
  // Formato de validação: { Message: "Dados inválidos", Errors: [{ Property, Message }] }
  if (Array.isArray(c["Errors"]) && c["Errors"].length) {
    const detalhes = (c["Errors"] as { Property?: string; Message?: string }[])
      .map((e) => [e.Property, e.Message].filter(Boolean).join(": "))
      .join("; ");
    return `${typeof c["Message"] === "string" ? `${c["Message"]} — ` : ""}${detalhes}`;
  }
  if (typeof c["Message"] === "string" && c["Message"]) return c["Message"] as string;
  if (typeof c["message"] === "string" && c["message"]) return c["message"] as string;
  if (Array.isArray(c["Mensagens"]) && c["Mensagens"].length) return (c["Mensagens"] as unknown[]).join(" ");
  return null;
}

interface Opcoes {
  query?: Record<string, string | number | boolean>;
  corpo?: unknown;
  /** Tentativas extras ao receber 429 (padrão 4: espera 15s, 30s, 60s, 120s). */
  tentativas429?: number;
}

/**
 * Chama uma rota de LEITURA da SIEG com JWT do sistema + token OAuth da conta.
 * Lança ErroSieg com a mensagem da SIEG quando a resposta não for 2xx.
 */
export async function chamarSieg<T = unknown>(rota: string, opcoes: Opcoes = {}): Promise<T> {
  const config = ROTAS_PERMITIDAS[rota];
  if (!config) {
    // Trava de segurança: nada fora da lista de leitura sai daqui.
    throw new ErroSieg(`Rota da SIEG não permitida (somente leitura): ${rota}`, null);
  }

  const url = new URL(BASE + rota);
  for (const [k, v] of Object.entries(opcoes.query ?? {})) url.searchParams.set(k, String(v));

  const maxTentativas = opcoes.tentativas429 ?? 4;
  for (let tentativa = 0; ; tentativa++) {
    await aguardarVez(rota, config.porMinuto);
    const [jwt, oauth] = await Promise.all([obterTokenSistema(), obterTokenOAuth()]);
    const inicio = Date.now();
    let resposta: globalThis.Response;
    try {
      resposta = await fetch(url, {
        method: config.metodo,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-OAuth-Token": oauth,
          Accept: "application/json",
          ...(opcoes.corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const msg = `Não foi possível falar com a SIEG: ${error instanceof Error ? error.message : String(error)}`;
      await registrar(rota, null, inicio, msg);
      throw new ErroSieg(msg, null);
    }

    // Lido como bytes: a SIEG às vezes devolve o arquivo (ZIP/PDF) em binário
    // direto, e ler isso como texto corrompe o conteúdo (visto em produção em
    // 05/11/2026 no baixar-xmls: "PK..." -- um ZIP cru).
    const bytes = Buffer.from(await resposta.arrayBuffer());
    const binario =
      (bytes[0] === 0x50 && bytes[1] === 0x4b) || // ZIP
      (bytes[0] === 0x1f && bytes[1] === 0x8b) || // gzip
      bytes.subarray(0, 4).toString("latin1") === "%PDF" ||
      /application\/(zip|octet-stream|pdf|x-zip)/i.test(resposta.headers.get("content-type") ?? "");
    const texto = binario ? "" : bytes.toString("utf8");
    let corpo: unknown = binario ? bytes : texto;
    if (!binario) {
      try {
        corpo = texto ? JSON.parse(texto) : null;
      } catch {
        // resposta não-JSON (ex.: base64 puro) -- fica como texto
      }
    }

    if (resposta.status === 429 && tentativa < maxTentativas) {
      await registrar(rota, 429, inicio, "Limite de requisições (429) -- aguardando para tentar de novo");
      await esperar(15_000 * 2 ** tentativa);
      continue;
    }

    if (!resposta.ok) {
      const motivo = mensagemSieg(corpo) || texto.slice(0, 300) || "sem detalhes";
      // 404 "nenhum ... encontrado" é o jeito da SIEG dizer "lista acabou" ou
      // "mês sem notas": registra a chamada, mas não como erro no painel.
      const fimDeLista = resposta.status === 404 && /nenhum/i.test(motivo);
      await registrar(rota, resposta.status, inicio, fimDeLista ? null : motivo);
      throw new ErroSieg(`SIEG respondeu HTTP ${resposta.status}: ${motivo}`, resposta.status, corpo);
    }

    const env = corpo as Record<string, unknown> | null;
    if (env && typeof env === "object" && (env["IsFailure"] === true || env["IsSuccess"] === false || env["success"] === false)) {
      const motivo = mensagemSieg(env) || "SIEG recusou a requisição";
      await registrar(rota, resposta.status, inicio, motivo);
      throw new ErroSieg(motivo, resposta.status, corpo);
    }

    await registrar(rota, resposta.status, inicio, null);
    return corpo as T;
  }
}

/** Mantém só os últimos 30 dias do registro de chamadas. */
export async function limparRegistroChamadas(): Promise<void> {
  await prisma.siegChamada.deleteMany({ where: { criadoEm: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
}
