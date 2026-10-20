-- CreateEnum
CREATE TYPE "ModoConversa" AS ENUM ('HUMANO', 'AGENTE');

-- CreateEnum
CREATE TYPE "AutorMensagem" AS ENUM ('CLIENTE', 'ATENDENTE', 'AGENTE', 'AUTOMACAO', 'SISTEMA');

-- CreateEnum
CREATE TYPE "TipoMensagem" AS ENUM ('TEXTO', 'DOCUMENTO', 'IMAGEM', 'AUDIO');

-- CreateEnum
CREATE TYPE "StatusMensagem" AS ENUM ('RECEBIDA', 'PENDENTE', 'ENVIADA', 'ENTREGUE', 'LIDA', 'FALHA');

-- AlterEnum
ALTER TYPE "StatusAtendimento" ADD VALUE 'TRIAGEM';

-- DropForeignKey
ALTER TABLE "atendimentos" DROP CONSTRAINT "atendimentos_setor_id_fkey";

-- AlterTable
ALTER TABLE "atendimentos" ADD COLUMN     "conversa_id" TEXT,
ADD COLUMN     "motivo_id" TEXT,
ALTER COLUMN "motivo" DROP NOT NULL,
ALTER COLUMN "cliente_id" DROP NOT NULL,
ALTER COLUMN "setor_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "motivos_atendimento" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "motivos_atendimento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentes_ia" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "instrucoes" TEXT NOT NULL DEFAULT '',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setor_id" TEXT,

    CONSTRAINT "agentes_ia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversas" (
    "id" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "nome_exibicao" TEXT,
    "canal" TEXT NOT NULL DEFAULT 'whatsapp',
    "modo" "ModoConversa" NOT NULL DEFAULT 'HUMANO',
    "nao_lidas" INTEGER NOT NULL DEFAULT 0,
    "ultima_mensagem_em" TIMESTAMP(3),
    "ultima_mensagem_texto" TEXT,
    "ultima_entrada_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliente_id" TEXT,
    "contato_id" TEXT,
    "agente_id" TEXT,

    CONSTRAINT "conversas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensagens" (
    "id" TEXT NOT NULL,
    "autor" "AutorMensagem" NOT NULL,
    "tipo" "TipoMensagem" NOT NULL DEFAULT 'TEXTO',
    "texto" TEXT,
    "interna" BOOLEAN NOT NULL DEFAULT false,
    "status" "StatusMensagem" NOT NULL DEFAULT 'PENDENTE',
    "erro" TEXT,
    "id_externo" TEXT,
    "arquivo_nome" TEXT,
    "arquivo_caminho" TEXT,
    "mime_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversa_id" TEXT NOT NULL,
    "usuario_id" TEXT,
    "agente_id" TEXT,
    "protocolo_id" TEXT,

    CONSTRAINT "mensagens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "motivos_atendimento_nome_key" ON "motivos_atendimento"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "agentes_ia_nome_key" ON "agentes_ia"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "conversas_telefone_key" ON "conversas"("telefone");

-- CreateIndex
CREATE INDEX "conversas_ultima_mensagem_em_idx" ON "conversas"("ultima_mensagem_em");

-- CreateIndex
CREATE UNIQUE INDEX "mensagens_id_externo_key" ON "mensagens"("id_externo");

-- CreateIndex
CREATE INDEX "mensagens_conversa_id_created_at_idx" ON "mensagens"("conversa_id", "created_at");

-- CreateIndex
CREATE INDEX "atendimentos_conversa_id_idx" ON "atendimentos"("conversa_id");

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_motivo_id_fkey" FOREIGN KEY ("motivo_id") REFERENCES "motivos_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentes_ia" ADD CONSTRAINT "agentes_ia_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos_cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_agente_id_fkey" FOREIGN KEY ("agente_id") REFERENCES "agentes_ia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_agente_id_fkey" FOREIGN KEY ("agente_id") REFERENCES "agentes_ia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_protocolo_id_fkey" FOREIGN KEY ("protocolo_id") REFERENCES "protocolos_entrega"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Motivos iniciais (dá para editar/desativar depois)
INSERT INTO "motivos_atendimento" ("id", "nome") VALUES
  (gen_random_uuid()::text, 'Envio de documentos'),
  (gen_random_uuid()::text, 'Dúvida sobre guia ou imposto'),
  (gen_random_uuid()::text, 'Segunda via de guia'),
  (gen_random_uuid()::text, 'Folha de pagamento / admissão / rescisão'),
  (gen_random_uuid()::text, 'Abertura ou alteração de empresa'),
  (gen_random_uuid()::text, 'Certidões e certificado digital'),
  (gen_random_uuid()::text, 'Parcelamento'),
  (gen_random_uuid()::text, 'Financeiro / honorários'),
  (gen_random_uuid()::text, 'Outros');
