-- PostgreSQL requires a commit before a newly added enum value is used.
ALTER TYPE "public"."authentication_method" ADD VALUE 'DRIVER_ACCESS_CODE';
