// Conversas de WhatsApp de demonstração para a caixa de entrada do
// atendimento: uma em cada situação (triagem, fila, em atendimento,
// finalizada). Só roda se ainda não houver nenhuma conversa.
// Chamado pelo seed-demo; também roda sozinho: npm run prisma:seed-conversas
import type { AutorMensagem, PrismaClient, StatusAtendimento } from "@prisma/client";

type Fala = [autor: AutorMensagem, texto: string, minutosAtras: number, interna?: boolean];

interface Cenario {
  status: StatusAtendimento;
  setor: string | null;
  contato: "socio" | { telefone: string; nome: string };
  falas: Fala[];
  motivo?: string;
  // Minutos entre abrir e alguém iniciar o atendimento.
  esperaMin?: number;
}

const CENARIOS: Cenario[] = [
  {
    status: "TRIAGEM",
    setor: null,
    contato: "socio",
    falas: [["CLIENTE", "Bom dia! Preciso da segunda via do DAS de setembro, perdi o boleto 😅", 12]],
  },
  {
    status: "TRIAGEM",
    setor: null,
    contato: { telefone: "5585988776655", nome: "Juliana Rocha" },
    falas: [
      ["CLIENTE", "Olá, boa tarde!", 26],
      ["CLIENTE", "Vocês fazem a transformação de MEI para LTDA? Queria um orçamento.", 25],
    ],
  },
  {
    status: "AGUARDANDO",
    setor: "Pessoal/Folha",
    contato: "socio",
    falas: [["CLIENTE", "A funcionária nova começa segunda. O que vocês precisam pra fazer a admissão?", 7]],
  },
  {
    status: "EM_ATENDIMENTO",
    setor: "Fiscal",
    contato: "socio",
    esperaMin: 4,
    falas: [
      ["CLIENTE", "Oi, recebi uma notificação da SEFAZ sobre ICMS. É grave?", 48],
      ["ATENDENTE", "Olá! Pode me mandar uma foto da notificação, por favor?", 44],
      ["CLIENTE", "Mandei por e-mail agora, pro fiscal@", 40],
      ["ATENDENTE", "Cliente com histórico de diferença de alíquota em 2025, conferir antes de responder.", 39, true],
      ["ATENDENTE", "Recebi! Vou analisar e te retorno ainda hoje.", 38],
      ["CLIENTE", "Obrigado!", 37],
    ],
  },
  {
    status: "EM_ATENDIMENTO",
    setor: "Financeiro",
    contato: "socio",
    esperaMin: 2,
    falas: [
      ["CLIENTE", "Boa tarde, o boleto dos honorários desse mês ainda não chegou", 15],
      ["ATENDENTE", "Boa tarde! Vou verificar com o financeiro e já te envio.", 12],
    ],
  },
  {
    status: "FINALIZADO",
    setor: "Fiscal",
    contato: "socio",
    motivo: "Parcelamento",
    esperaMin: 9,
    falas: [
      ["CLIENTE", "Bom dia, a parcela do parcelamento desse mês já tá disponível?", 1500],
      ["ATENDENTE", "Bom dia! Já está, vou te mandar a guia aqui.", 1490],
      ["ATENDENTE", "Pronto, enviada. Vencimento dia 30.", 1480],
      ["CLIENTE", "Perfeito, obrigada!", 1475],
    ],
  },
  {
    status: "FINALIZADO",
    setor: "Contábil",
    contato: "socio",
    motivo: "Envio de documentos",
    esperaMin: 30,
    falas: [
      ["AUTOMACAO", "Olá! Virou o mês 🙂 Por favor, envie os extratos bancários e as despesas de setembro para fecharmos a contabilidade.", 3000],
      ["CLIENTE", "Oi! Segue o extrato do Itaú, o do BB mando amanhã.", 2900],
      ["ATENDENTE", "Recebido, obrigado! Fico no aguardo do BB.", 2870],
    ],
  },
];

function minutosAtras(min: number): Date {
  return new Date(Date.now() - min * 60_000);
}

export async function criarConversasDemo(prisma: PrismaClient): Promise<number> {
  if ((await prisma.conversa.count()) > 0) return 0;

  const setores = await prisma.setor.findMany();
  const motivos = await prisma.motivoAtendimento.findMany();
  const usuarios = await prisma.usuario.findMany({ where: { ativo: true } });
  const socios = await prisma.contatoCliente.findMany({
    where: { ativo: true, recebeTodos: true, celular: { not: null }, cliente: { ativo: true } },
    orderBy: { createdAt: "asc" },
  });
  const setorPorNome = new Map(setores.map((s) => [s.nome, s]));

  let criadas = 0;
  let proximoSocio = 0;
  for (const cenario of CENARIOS) {
    let telefone: string;
    let nomeExibicao: string | null = null;
    let clienteId: string | null = null;
    let contatoId: string | null = null;
    if (cenario.contato === "socio") {
      const socio = socios[proximoSocio++];
      if (!socio) continue;
      telefone = socio.celular!.replace(/\D/g, "");
      nomeExibicao = socio.nome;
      clienteId = socio.clienteId;
      contatoId = socio.id;
    } else {
      telefone = cenario.contato.telefone;
      nomeExibicao = cenario.contato.nome;
    }

    const setor = cenario.setor ? setorPorNome.get(cenario.setor) ?? null : null;
    let responsavelId: string | null = null;
    if (setor) {
      const vinculo = clienteId
        ? await prisma.clienteResponsavel.findUnique({ where: { clienteId_setorId: { clienteId, setorId: setor.id } } })
        : null;
      responsavelId = vinculo?.usuarioId ?? setor.responsavelId ?? usuarios.find((u) => u.setorId === setor.id)?.id ?? null;
    }

    const primeira = Math.max(...cenario.falas.map((f) => f[2]));
    const ultima = Math.min(...cenario.falas.map((f) => f[2]));
    const doCliente = cenario.falas.filter((f) => f[0] === "CLIENTE");
    const naoLidas = cenario.status === "TRIAGEM" || cenario.status === "AGUARDANDO" ? doCliente.length : 0;
    const ultimaVisivel = [...cenario.falas].filter((f) => !f[3]).sort((a, b) => a[2] - b[2])[0];

    const conversa = await prisma.conversa.create({
      data: {
        telefone,
        nomeExibicao,
        clienteId,
        contatoId,
        naoLidas,
        ultimaMensagemEm: minutosAtras(ultimaVisivel[2]),
        ultimaMensagemTexto: ultimaVisivel[1].slice(0, 140),
        ultimaEntradaEm: doCliente.length ? minutosAtras(Math.min(...doCliente.map((f) => f[2]))) : null,
      },
    });

    for (const [autor, texto, min, interna] of cenario.falas) {
      await prisma.mensagem.create({
        data: {
          conversaId: conversa.id,
          autor,
          texto,
          interna: Boolean(interna),
          status: autor === "CLIENTE" ? "RECEBIDA" : "LIDA",
          usuarioId: autor === "ATENDENTE" ? responsavelId : null,
          createdAt: minutosAtras(min),
        },
      });
    }

    const iniciado = cenario.esperaMin !== undefined ? minutosAtras(primeira - cenario.esperaMin) : null;
    await prisma.atendimento.create({
      data: {
        conversaId: conversa.id,
        clienteId,
        setorId: setor?.id ?? null,
        responsavelId,
        status: cenario.status,
        abertoEm: minutosAtras(primeira),
        iniciadoEm: iniciado,
        finalizadoEm: cenario.status === "FINALIZADO" ? minutosAtras(ultima - 2) : null,
        motivoId: cenario.motivo ? motivos.find((m) => m.nome === cenario.motivo)?.id ?? null : null,
      },
    });
    if (cenario.status === "FINALIZADO") {
      const quem = usuarios.find((u) => u.id === responsavelId)?.nome ?? "Atendente";
      await prisma.mensagem.create({
        data: {
          conversaId: conversa.id,
          autor: "SISTEMA",
          texto: `Atendimento finalizado por ${quem} · ${cenario.motivo}`,
          status: "ENVIADA",
          createdAt: minutosAtras(ultima - 2),
        },
      });
    }
    criadas += 1;
  }
  return criadas;
}

// Execução direta.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  criarConversasDemo(prisma)
    .then((n) => console.log(`Conversas: ${n} criada(s).`))
    .catch((erro) => {
      console.error(erro);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
