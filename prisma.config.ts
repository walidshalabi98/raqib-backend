import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma does not read .env by itself once a config file exists, hence the dotenv import.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
