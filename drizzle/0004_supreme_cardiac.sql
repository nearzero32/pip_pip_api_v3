-- PostgreSQL requires a commit boundary before an added enum value can be used.
ALTER TYPE "public"."authentication_method" ADD VALUE 'PASSWORD';
