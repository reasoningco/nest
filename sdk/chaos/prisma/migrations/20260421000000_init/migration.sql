-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "githubLogin" TEXT,
    "jiraAccountId" TEXT,
    "role" TEXT
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "metadata" TEXT NOT NULL,
    "featureKey" TEXT,
    CONSTRAINT "Activity_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "source" TEXT NOT NULL,
    "firstSeen" DATETIME NOT NULL,
    "lastSeen" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lastSync" DATETIME NOT NULL,
    "lastError" TEXT
);

-- CreateTable
CREATE TABLE "UnmappedContributor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubLogin" TEXT,
    "jiraAccountId" TEXT,
    "firstSeen" DATETIME NOT NULL,
    "lastSeen" DATETIME NOT NULL,
    "sampleActivity" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_githubLogin_key" ON "Person"("githubLogin");
CREATE UNIQUE INDEX "Person_jiraAccountId_key" ON "Person"("jiraAccountId");
CREATE UNIQUE INDEX "Activity_externalId_key" ON "Activity"("externalId");
CREATE INDEX "Activity_personId_occurredAt_idx" ON "Activity"("personId", "occurredAt");
CREATE INDEX "Activity_featureKey_idx" ON "Activity"("featureKey");
CREATE INDEX "Activity_occurredAt_idx" ON "Activity"("occurredAt");
CREATE UNIQUE INDEX "Feature_featureKey_key" ON "Feature"("featureKey");
CREATE UNIQUE INDEX "UnmappedContributor_githubLogin_key" ON "UnmappedContributor"("githubLogin");
CREATE UNIQUE INDEX "UnmappedContributor_jiraAccountId_key" ON "UnmappedContributor"("jiraAccountId");
