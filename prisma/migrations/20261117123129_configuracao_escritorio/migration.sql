-- CreateTable
CREATE TABLE "configuracao_escritorio" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "nome" TEXT NOT NULL DEFAULT 'Apta Contabilidade',
    "razao_social" TEXT,
    "cnpj" TEXT,
    "crc" TEXT,
    "responsavel_tecnico" TEXT,
    "email" TEXT,
    "telefone" TEXT,
    "whatsapp" TEXT,
    "site" TEXT,
    "endereco" TEXT,
    "cidade" TEXT NOT NULL DEFAULT 'Fortaleza',
    "uf" TEXT NOT NULL DEFAULT 'CE',
    "assinatura_mensagens" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracao_escritorio_pkey" PRIMARY KEY ("id")
);
