-- NOTA: divergência pré-existente entre schema.prisma e o banco (AccountPayable.storeId),
-- sem relação com o módulo de caminhões — deliberadamente não removida aqui, ver as
-- migrations sigma_gap_phase1_8 e trucks_module para o mesmo caso.

-- CreateTable
CREATE TABLE "Truck" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "assignedEmployeeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TruckTrip" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startKm" INTEGER NOT NULL,
    "startFuelLevel" TEXT NOT NULL,
    "startCondition" TEXT,
    "startPhotoUrl" TEXT,
    "endedAt" TIMESTAMP(3),
    "endKm" INTEGER,
    "endFuelLevel" TEXT,
    "endCondition" TEXT,
    "endPhotoUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TruckTrip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Truck_plate_key" ON "Truck"("plate");

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckTrip" ADD CONSTRAINT "TruckTrip_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckTrip" ADD CONSTRAINT "TruckTrip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
