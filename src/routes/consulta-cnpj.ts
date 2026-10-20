// Consulta de CNPJ na Receita via BrasilAPI (pública, sem chave), para
// preencher o cadastro da empresa: razão social, CNAE, endereço, sócios...
// Passa pelo backend para normalizar os dados e não depender de CORS.
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const consultaCnpjRouter = Router();

consultaCnpjRouter.use(autenticar);

const URL_BRASILAPI = "https://brasilapi.com.br/api/cnpj/v1/";

interface RespostaBrasilApi {
  razao_social?: string;
  nome_fantasia?: string | null;
  cnae_fiscal?: number | null;
  cnae_fiscal_descricao?: string | null;
  cnaes_secundarios?: { codigo: number; descricao: string }[] | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  uf?: string | null;
  data_inicio_atividade?: string | null;
  descricao_situacao_cadastral?: string | null;
  opcao_pelo_simples?: boolean | null;
  opcao_pelo_mei?: boolean | null;
  qsa?: { nome_socio?: string; qualificacao_socio?: string }[] | null;
}

// 4721102 → "4721-1/02"
function formatarCnae(codigo: number | null | undefined): string | null {
  if (!codigo) return null;
  const d = String(codigo).padStart(7, "0");
  return `${d.slice(0, 4)}-${d.slice(4, 5)}/${d.slice(5)}`;
}

// "FORTALEZA" → "Fortaleza"; mantém preposições minúsculas.
function nomeProprio(texto: string | null | undefined): string | null {
  if (!texto) return null;
  return texto
    .toLowerCase()
    .split(/\s+/)
    .map((p, i) => (i > 0 && ["de", "da", "do", "das", "dos", "e"].includes(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

consultaCnpjRouter.get("/consulta-cnpj/:cnpj", asyncHandler(async (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, "");
  if (cnpj.length !== 14) {
    res.status(400).json({ erro: "CNPJ deve ter 14 dígitos" });
    return;
  }

  const jaCadastrado = await prisma.cliente.findUnique({
    where: { cnpj },
    select: { id: true, razaoSocial: true, codigo: true },
  });

  let resposta: globalThis.Response;
  try {
    // Sem User-Agent a BrasilAPI responde 403.
    resposta = await fetch(`${URL_BRASILAPI}${cnpj}`, {
      headers: { "User-Agent": "SistemaApta/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    res.status(502).json({ erro: "Consulta à Receita indisponível agora. Preencha os dados à mão." });
    return;
  }
  if (resposta.status === 404) {
    res.status(404).json({ erro: "CNPJ não encontrado na Receita" });
    return;
  }
  if (!resposta.ok) {
    res.status(502).json({ erro: `Consulta à Receita falhou (${resposta.status}). Preencha os dados à mão.` });
    return;
  }
  const d = (await resposta.json()) as RespostaBrasilApi;

  const endereco = [
    [d.logradouro, d.numero].filter(Boolean).join(", "),
    d.complemento,
    d.bairro,
  ]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" - ");

  // Sócio-administrador (ou administrador) é o responsável legal sugerido.
  const socios = (d.qsa ?? [])
    .filter((s) => s.nome_socio)
    .map((s) => ({
      nome: nomeProprio(s.nome_socio)!,
      cargo: s.qualificacao_socio ?? null,
      responsavelLegal: /administrador/i.test(s.qualificacao_socio ?? ""),
    }));

  res.json({
    jaCadastrado,
    razaoSocial: d.razao_social ?? null,
    nomeFantasia: d.nome_fantasia || null,
    situacaoCadastral: d.descricao_situacao_cadastral ?? null,
    dataAbertura: d.data_inicio_atividade ?? null,
    cnaePrincipal: formatarCnae(d.cnae_fiscal),
    cnaeDescricao: d.cnae_fiscal_descricao ?? null,
    cnaesSecundarios: (d.cnaes_secundarios ?? [])
      .filter((c) => c.codigo)
      .map((c) => ({ codigo: formatarCnae(c.codigo)!, descricao: c.descricao })),
    cep: d.cep ?? null,
    endereco: endereco || null,
    cidade: nomeProprio(d.municipio),
    uf: d.uf ?? null,
    simples: Boolean(d.opcao_pelo_simples),
    mei: Boolean(d.opcao_pelo_mei),
    socios,
  });
}));
