-- CreateEnum
CREATE TYPE "StatusEnvio" AS ENUM ('AGUARDANDO_ENVIO', 'ENVIADO', 'FALHA');

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "apelido" TEXT,
ADD COLUMN     "cidade" TEXT,
ADD COLUMN     "codigo" SERIAL NOT NULL,
ADD COLUMN     "grupo_empresas" TEXT,
ADD COLUMN     "honorario" DOUBLE PRECISION,
ADD COLUMN     "uf" CHAR(2);

-- AlterTable
ALTER TABLE "tipos_obrigacao" ADD COLUMN     "alerta_nao_lida" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "contatos_cliente" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cargo" TEXT,
    "celular" TEXT,
    "email" TEXT,
    "recebe_todos" BOOLEAN NOT NULL DEFAULT true,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliente_id" TEXT NOT NULL,

    CONSTRAINT "contatos_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feriados" (
    "id" TEXT NOT NULL,
    "data" DATE NOT NULL,
    "descricao" TEXT NOT NULL,
    "recorrente" BOOLEAN NOT NULL DEFAULT true,
    "uf" CHAR(2),
    "cidade" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feriados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documentos_entrega" (
    "id" TEXT NOT NULL,
    "nome_arquivo" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "tamanho" INTEGER NOT NULL,
    "caminho" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "obrigacao_id" TEXT NOT NULL,
    "usuario_id" TEXT,

    CONSTRAINT "documentos_entrega_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocolos_entrega" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "destinatario_nome" TEXT NOT NULL,
    "destinatario_email" TEXT,
    "destinatario_celular" TEXT,
    "status" "StatusEnvio" NOT NULL DEFAULT 'AGUARDANDO_ENVIO',
    "canal" TEXT,
    "erro_envio" TEXT,
    "enviado_em" TIMESTAMP(3),
    "lido_em" TIMESTAMP(3),
    "acessos" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "obrigacao_id" TEXT NOT NULL,
    "contato_id" TEXT,
    "usuario_id" TEXT,

    CONSTRAINT "protocolos_entrega_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ContatoClienteToSetor" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ContatoClienteToSetor_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "contatos_cliente_cliente_id_idx" ON "contatos_cliente"("cliente_id");

-- CreateIndex
CREATE INDEX "documentos_entrega_obrigacao_id_idx" ON "documentos_entrega"("obrigacao_id");

-- CreateIndex
CREATE UNIQUE INDEX "protocolos_entrega_numero_key" ON "protocolos_entrega"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "protocolos_entrega_token_key" ON "protocolos_entrega"("token");

-- CreateIndex
CREATE INDEX "protocolos_entrega_obrigacao_id_idx" ON "protocolos_entrega"("obrigacao_id");

-- CreateIndex
CREATE INDEX "_ContatoClienteToSetor_B_index" ON "_ContatoClienteToSetor"("B");

-- CreateIndex
CREATE UNIQUE INDEX "clientes_codigo_key" ON "clientes"("codigo");

-- AddForeignKey
ALTER TABLE "contatos_cliente" ADD CONSTRAINT "contatos_cliente_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentos_entrega" ADD CONSTRAINT "documentos_entrega_obrigacao_id_fkey" FOREIGN KEY ("obrigacao_id") REFERENCES "obrigacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentos_entrega" ADD CONSTRAINT "documentos_entrega_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocolos_entrega" ADD CONSTRAINT "protocolos_entrega_obrigacao_id_fkey" FOREIGN KEY ("obrigacao_id") REFERENCES "obrigacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocolos_entrega" ADD CONSTRAINT "protocolos_entrega_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos_cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocolos_entrega" ADD CONSTRAINT "protocolos_entrega_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContatoClienteToSetor" ADD CONSTRAINT "_ContatoClienteToSetor_A_fkey" FOREIGN KEY ("A") REFERENCES "contatos_cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContatoClienteToSetor" ADD CONSTRAINT "_ContatoClienteToSetor_B_fkey" FOREIGN KEY ("B") REFERENCES "setores"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Numera as empresas existentes na ordem de cadastro (1, 2, 3…).
UPDATE "clientes" c SET "codigo" = n.rn
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, razao_social) AS rn FROM "clientes") n
WHERE c.id = n.id;
SELECT setval(pg_get_serial_sequence('"clientes"', 'codigo'), COALESCE((SELECT MAX("codigo") FROM "clientes"), 0) + 1, false);
