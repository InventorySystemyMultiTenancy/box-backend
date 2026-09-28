-- AlterTable
ALTER TABLE "Role" ADD COLUMN "baseRole" TEXT NOT NULL DEFAULT 'MECHANIC';

-- DataMigration: o cargo seed "Administrador" passa a ter baseRole ADMIN. Os demais
-- (o seed "Mecânico" e qualquer cargo customizado já existente, ex.: "motorista") já
-- nascem corretos com o default MECHANIC acima.
UPDATE "Role" SET "baseRole" = 'ADMIN' WHERE "slug" = 'admin';
