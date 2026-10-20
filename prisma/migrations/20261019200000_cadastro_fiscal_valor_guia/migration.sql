-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "atividades" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cep" TEXT,
ADD COLUMN     "cnae_descricao" TEXT,
ADD COLUMN     "cnae_principal" TEXT,
ADD COLUMN     "cnaes_secundarios" JSONB,
ADD COLUMN     "data_abertura" DATE,
ADD COLUMN     "endereco" TEXT,
ADD COLUMN     "inscricao_estadual" TEXT,
ADD COLUMN     "inscricao_municipal" TEXT,
ADD COLUMN     "notas_emitidas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "situacao_cadastral" TEXT;

-- AlterTable
ALTER TABLE "contatos_cliente" ADD COLUMN     "responsavel_legal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "obrigacoes" ADD COLUMN     "valor_guia" DOUBLE PRECISION;

