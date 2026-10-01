// Contatos de demonstração ("Contatos na empresa"): um sócio que recebe
// tudo, o financeiro (Fiscal + Financeiro) e, às vezes, o RH (Folha).
// Só cria para empresas que ainda não têm contato. Chamado pelo seed-demo;
// também roda sozinho: npm run prisma:seed-contatos
import type { PrismaClient } from "@prisma/client";

const NOMES_CONTATO = [
  "Francisca Lima", "José Holanda", "Ana Cavalcante", "Raimundo Bezerra", "Maria Alencar",
  "Antônio Pinheiro", "Luciana Sampaio", "Carlos Girão", "Patrícia Façanha", "Marcos Távora",
];

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function slug(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

export async function criarContatosDemo(
  prisma: PrismaClient,
  clientes: { id: string; razaoSocial: string }[],
  setores: { id: string; nome: string }[]
): Promise<number> {
  const setorPorNome = new Map(setores.map((s) => [s.nome, s.id]));
  const conectar = (...nomes: string[]) => nomes.flatMap((n) => (setorPorNome.has(n) ? [{ id: setorPorNome.get(n)! }] : []));
  let criados = 0;
  for (const cliente of clientes) {
    if ((await prisma.contatoCliente.count({ where: { clienteId: cliente.id } })) > 0) continue;
    const dominio = `${slug(cliente.razaoSocial.split(" ")[0]) || "empresa"}.com.br`;
    const socio = randomItem(NOMES_CONTATO);
    await prisma.contatoCliente.create({
      data: {
        clienteId: cliente.id,
        nome: socio,
        cargo: "Sócio(a)",
        email: `${slug(socio.split(" ")[0])}@${dominio}`,
        celular: `55859${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        recebeTodos: true,
      },
    });
    await prisma.contatoCliente.create({
      data: {
        clienteId: cliente.id,
        nome: "Financeiro",
        cargo: "Setor financeiro",
        email: `financeiro@${dominio}`,
        recebeTodos: false,
        setores: { connect: conectar("Fiscal", "Financeiro") },
      },
    });
    criados += 2;
    if (Math.random() < 0.5) {
      await prisma.contatoCliente.create({
        data: {
          clienteId: cliente.id,
          nome: randomItem(NOMES_CONTATO),
          cargo: "RH",
          email: `rh@${dominio}`,
          recebeTodos: false,
          setores: { connect: conectar("Pessoal/Folha") },
        },
      });
      criados += 1;
    }
  }
  return criados;
}

// Execução direta.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const [clientes, setores] = await Promise.all([prisma.cliente.findMany(), prisma.setor.findMany()]);
  criarContatosDemo(prisma, clientes, setores)
    .then((n) => console.log(`Contatos: ${n} criado(s).`))
    .catch((erro) => {
      console.error(erro);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
