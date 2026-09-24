import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SETORES = ["Fiscal", "Pessoal/Folha", "Contábil", "Financeiro", "Atendimento"];

async function main() {
  for (const nome of SETORES) {
    await prisma.setor.upsert({
      where: { nome },
      update: {},
      create: { nome },
    });
  }

  const emailAdmin = process.env.SEED_ADMIN_EMAIL ?? "admin@apta.com.br";
  const senhaAdmin = process.env.SEED_ADMIN_SENHA ?? "apta1234";

  const adminExistente = await prisma.usuario.findUnique({ where: { email: emailAdmin } });
  if (!adminExistente) {
    const senhaHash = await bcrypt.hash(senhaAdmin, 10);
    await prisma.usuario.create({
      data: {
        nome: "Administrador",
        email: emailAdmin,
        senhaHash,
        perfil: "ADMIN",
      },
    });
    console.log(`Usuário administrador criado: ${emailAdmin} / ${senhaAdmin}`);
  } else {
    console.log("Usuário administrador já existe, nada a fazer.");
  }
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
