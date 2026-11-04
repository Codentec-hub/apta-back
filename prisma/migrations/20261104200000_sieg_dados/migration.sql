-- AlterTable
ALTER TABLE "configuracao_sieg" ADD COLUMN     "oauth_erro_renovacao" TEXT,
ADD COLUMN     "oauth_renovado_em" TIMESTAMP(3),
ADD COLUMN     "ultima_sincronizacao_em" TIMESTAMP(3),
ADD COLUMN     "ultima_sincronizacao_erro" TEXT;

-- CreateTable
CREATE TABLE "sieg_empresas" (
    "id" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "uf_certificado" INTEGER,
    "certificado_expira_em" TIMESTAMP(3),
    "consulta_noturna" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "deletado" BOOLEAN NOT NULL DEFAULT false,
    "status_sieg" TEXT,
    "ultima_consulta_sieg" TIMESTAMP(3),
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sieg_empresas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sieg_contagens" (
    "id" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "papel" TEXT NOT NULL,
    "nfe" INTEGER NOT NULL DEFAULT 0,
    "nfce" INTEGER NOT NULL DEFAULT 0,
    "cte" INTEGER NOT NULL DEFAULT 0,
    "cfe" INTEGER NOT NULL DEFAULT 0,
    "nfse" INTEGER NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sieg_contagens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sieg_notas" (
    "chave" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "documento_empresa" TEXT NOT NULL,
    "papel" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "emissao" TIMESTAMP(3),
    "numero" TEXT,
    "serie" TEXT,
    "emitente_documento" TEXT,
    "emitente_nome" TEXT,
    "destinatario_documento" TEXT,
    "destinatario_nome" TEXT,
    "valor" DOUBLE PRECISION,
    "natureza_operacao" TEXT,
    "capturada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sieg_notas_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "sieg_buscas_notas" (
    "id" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "papel" TEXT NOT NULL,
    "situacao" TEXT NOT NULL,
    "paginas" INTEGER NOT NULL DEFAULT 0,
    "notas" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "iniciada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluida_em" TIMESTAMP(3),

    CONSTRAINT "sieg_buscas_notas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sieg_chamadas" (
    "id" TEXT NOT NULL,
    "rota" TEXT NOT NULL,
    "status" INTEGER,
    "duracao_ms" INTEGER NOT NULL,
    "erro" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sieg_chamadas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sieg_empresas_documento_idx" ON "sieg_empresas"("documento");

-- CreateIndex
CREATE INDEX "sieg_contagens_mes_idx" ON "sieg_contagens"("mes");

-- CreateIndex
CREATE UNIQUE INDEX "sieg_contagens_documento_mes_papel_key" ON "sieg_contagens"("documento", "mes", "papel");

-- CreateIndex
CREATE INDEX "sieg_notas_documento_empresa_mes_idx" ON "sieg_notas"("documento_empresa", "mes");

-- CreateIndex
CREATE INDEX "sieg_buscas_notas_documento_mes_idx" ON "sieg_buscas_notas"("documento", "mes");

-- CreateIndex
CREATE INDEX "sieg_chamadas_criado_em_idx" ON "sieg_chamadas"("criado_em");

